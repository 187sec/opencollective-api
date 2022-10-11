import { expect } from 'chai';
import { pick } from 'lodash';

import { checkExpense } from '../../../../server/lib/security/check';
import {
  fakeCollective,
  fakeExpense,
  fakeHost,
  fakePayoutMethod,
  fakeUser,
  multiple,
} from '../../../test-helpers/fake-data';
import { resetTestDB } from '../../../utils';

describe('lib/security/check', () => {
  let expense;
  before(resetTestDB);
  before(async () => {
    await multiple(fakeExpense, 4, { status: 'PAID' });
    expense = await fakeExpense({ amount: 2000e2 });
    await multiple(fakeExpense, 2, { ...pick(expense, ['UserId', 'CollectiveId']), status: 'PAID', amount: 1000e2 });
    await multiple(fakeExpense, 2, { ...pick(expense, ['UserId', 'CollectiveId']), status: 'SPAM' });
  });

  it('works', async () => {
    const check = await checkExpense(expense);
    console.log(check);
  });
});
