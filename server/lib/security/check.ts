import { capitalize, filter, find, isEmpty, mapValues, round } from 'lodash';

import status from '../../constants/expense_status';
import models, { sequelize } from '../../models';

export enum Scope {
  AUTHOR = 'AUTHOR',
  COLLECTIVE = 'COLLECTIVE',
  PAYEE = 'PAYEE',
  PAYOUT_METHOD = 'PAYOUT_METHOD',
}

export enum Level {
  PASS = 'PASS',
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
}

type SecurityCheck = {
  scope: Scope;
  level: Level;
  message: string;
  details?: string;
  meta?: Record<string, any>;
};

const roundProps = keys => obj => mapValues(obj, (value, key) => (keys.includes(key) ? round(value, 2) : value));

const getExpensesStats = where =>
  models.Expense.findAll({
    where,
    attributes: [
      'CollectiveId',
      'status',
      [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
      [sequelize.fn('AVG', sequelize.col('amount')), 'amount_avg'],
      [sequelize.fn('STDDEV', sequelize.col('amount')), 'amount_stddev'],
      [sequelize.fn('MAX', sequelize.col('createdAt')), 'lastCreatedAt'],
    ],
    group: ['CollectiveId', 'status'],
    order: [['lastCreatedAt', 'desc']],
    raw: true,
  }).then(results => results.map(roundProps(['amount_avg', 'amount_stddev'])));

export const checkExpense = async (expense: typeof models.Expense): Promise<SecurityCheck[]> => {
  const checks: SecurityCheck[] = [];
  const addBooleanCheck = (condition: boolean, ifTrue: SecurityCheck, ifFalse?: SecurityCheck) =>
    condition ? checks.push(ifTrue) : ifFalse ? checks.push(ifFalse) : null;

  await expense.reload({
    include: [
      { association: 'collective' },
      { association: 'fromCollective' },
      { model: models.User, include: [{ association: 'collective' }] },
      { model: models.PayoutMethod },
    ],
  });
  await expense.User.populateRoles();
  const authorIsPayee = expense.User.isAdminOfCollective(expense.fromCollective);

  // Author
  addBooleanCheck(
    expense.User.hasTwoFactorAuthentication,
    { scope: Scope.AUTHOR, level: Level.PASS, message: 'Author has 2FA enabled' },
    { scope: Scope.AUTHOR, level: Level.MEDIUM, message: 'Author is not using 2FA' },
  );
  addBooleanCheck(expense.User.isAdminOfCollective(expense.collective), {
    scope: Scope.AUTHOR,
    level: Level.PASS,
    message: 'Author is the admin of the collective',
  });
  addBooleanCheck(expense.User.isAdmin(expense.HostCollectiveId), {
    scope: Scope.AUTHOR,
    level: Level.PASS,
    message: 'Author is the admin of the fiscal host',
  });

  const checkExpenseStats = async (where, { scope }: { scope: Scope }) => {
    const stats = await getExpensesStats(where);
    console.log(stats);

    const spamOrRejected = filter(stats, stat => [status.SPAM, status.REJECTED].includes(stat.status));
    addBooleanCheck(!isEmpty(spamOrRejected), {
      scope,
      level: Level.HIGH,
      message: `${capitalize(scope)} has expenses that were previously rejected or marked as SPAM`,
      meta: spamOrRejected,
    });
    const paidInCollective = find(stats, { status: status.PAID, CollectiveId: expense.CollectiveId });
    addBooleanCheck(
      paidInCollective?.count,
      {
        scope,
        level: Level.PASS,
        message: `${capitalize(scope)} was successfully paid ${paidInCollective.count} times by this collective`,
        meta: paidInCollective,
      },
      {
        scope,
        level: Level.LOW,
        message: `${capitalize(scope)} was never been paid by this collective`,
        meta: paidInCollective,
      },
    );
    if (paidInCollective) {
      addBooleanCheck(expense.amount > paidInCollective.amount_avg + paidInCollective.amount_stddev, {
        scope,
        level: Level.MEDIUM,
        message: `Expense amount is above normal for this ${capitalize(scope)}: avg. ${paidInCollective.amount_avg}`,
        meta: paidInCollective,
      });
    }
  };

  await checkExpenseStats({ UserId: expense.UserId }, { scope: Scope.AUTHOR });
  if (!authorIsPayee) {
    await checkExpenseStats({ FromCollectiveId: expense.FromCollectiveId }, { scope: Scope.PAYEE });
  }

  return checks;
};
