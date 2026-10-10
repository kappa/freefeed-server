import { before, describe, it } from 'mocha';
import unexpected from 'unexpected';
import unexpectedDate from 'unexpected-date';
import { DateTime } from 'luxon';

import { PubSub, dbAdapter } from '../../app/models';
import cleanDB from '../dbCleaner';
import {
  ACT_DISABLE_INVITES_FOR_USER,
  ACT_ENABLE_INVITES_FOR_USER,
  ACT_FREEZE_USER,
  ACT_GIVE_MODERATOR_RIGHTS,
  ACT_REMOVE_MODERATOR_RIGHTS,
  ACT_SUSPEND_USER,
  ACT_UNFREEZE_USER,
  ACT_UNSUSPEND_USER,
  ROLE_ADMIN,
  ROLE_MODERATOR,
} from '../../app/models/admins';
import { GONE_SUSPENDED } from '../../app/models/user';

import {
  type UserCtx,
  performJSONRequest,
  authHeaders,
  cmpBy,
  createUserAsync,
  createTestUser,
} from './functional_test_helper';

const expect = unexpected.clone();
expect.use(unexpectedDate);

describe('Admin API', () => {
  before(() => cleanDB(dbAdapter.database));

  let luna: UserCtx;
  let mars: UserCtx;
  let venus: UserCtx;

  before(async () => {
    luna = await createTestUser('luna');
    mars = await createTestUser('mars');
    // Venus is created by Luna's invite
    const invitationCode = await luna.user.createInvitation({
      message: 'hi',
      lang: 'en',
      singleUse: true,
      groups: [],
      users: [],
    });
    const invitation = await dbAdapter.getInvitation(invitationCode);
    venus = await createUserAsync('venus', 'pw', { invitationId: invitation?.id });
    await Promise.all([
      dbAdapter.setUserAdminRole(luna.user.id, ROLE_ADMIN, true, {
        YES_I_WANT_TO_SET_ADMIN_FOR_TEST_ONLY: true,
      }),
      dbAdapter.setUserAdminRole(mars.user.id, ROLE_MODERATOR, true),
    ]);
  });

  describe('Who am I?', () => {
    it(`should require authorization for admin's whoami`, async () => {
      const response = await performJSONRequest('GET', `/api/admin/whoami`);
      await expect(response, 'to satisfy', { __httpCode: 401 });
    });

    it(`should not let non-admins to see admin's whoami`, async () => {
      const response = await performJSONRequest(
        'GET',
        `/api/admin/whoami`,
        null,
        authHeaders(venus),
      );
      await expect(response, 'to satisfy', { __httpCode: 403 });
    });

    it(`should let moderators to see admin's whoami`, async () => {
      const response = await performJSONRequest(
        'GET',
        `/api/admin/whoami`,
        null,
        authHeaders(mars),
      );
      await expect(response, 'to satisfy', {
        __httpCode: 200,
        user: { id: mars.user.id, roles: [ROLE_MODERATOR] },
      });
    });

    it(`should let true admins to see admin's whoami`, async () => {
      const response = await performJSONRequest(
        'GET',
        `/api/admin/whoami`,
        null,
        authHeaders(luna),
      );
      await expect(response, 'to satisfy', {
        __httpCode: 200,
        user: { id: luna.user.id, roles: [ROLE_ADMIN] },
      });
    });
  });

  describe('Journal', () => {
    it(`should not let anonymous users to see journal`, async () => {
      const response = await performJSONRequest('GET', `/api/admin/journal`);
      await expect(response, 'to satisfy', { __httpCode: 401 });
    });

    it(`should not let regular users to see journal`, async () => {
      const response = await performJSONRequest(
        'GET',
        `/api/admin/journal`,
        null,
        authHeaders(venus),
      );
      await expect(response, 'to satisfy', { __httpCode: 403 });
    });

    it(`should let moderators to see journal`, async () => {
      const response = await performJSONRequest(
        'GET',
        `/api/admin/journal`,
        null,
        authHeaders(mars),
      );
      await expect(response, 'to satisfy', { __httpCode: 200, actions: [], isLastPage: true });
    });
  });

  describe('Add/remove/list moderators', () => {
    it(`should not let anonymous users to see members list`, async () => {
      const response = await performJSONRequest('GET', `/api/admin/members`);
      await expect(response, 'to satisfy', { __httpCode: 401 });
    });

    it(`should not let regular users to see members list`, async () => {
      const response = await performJSONRequest(
        'GET',
        `/api/admin/members`,
        null,
        authHeaders(venus),
      );
      await expect(response, 'to satisfy', { __httpCode: 403 });
    });

    it(`should not let moderators to see members list`, async () => {
      const response = await performJSONRequest(
        'GET',
        `/api/admin/members`,
        null,
        authHeaders(mars),
      );
      await expect(response, 'to satisfy', { __httpCode: 403 });
    });

    it(`should let admins to see members list of Mars and Luna`, async () => {
      const response = await performJSONRequest(
        'GET',
        `/api/admin/members`,
        null,
        authHeaders(luna),
      );
      await expect(response, 'to satisfy', {
        __httpCode: 200,
        users: expect.it(
          'when sorted by',
          cmpBy('id'),
          'to satisfy',
          [
            { id: luna.user.id, roles: [ROLE_ADMIN] },
            { id: mars.user.id, roles: [ROLE_MODERATOR] },
          ].sort(cmpBy('id')),
        ),
      });
    });

    it('should demote Mars from moderators', async () => {
      const response = await performJSONRequest(
        'POST',
        `/api/admin/members/${mars.username}/demote`,
        null,
        authHeaders(luna),
      );
      await expect(response, 'to satisfy', { __httpCode: 200, user: { roles: [] } });
    });

    it(`should have record about it in journal`, async () => {
      const response = await performJSONRequest(
        'GET',
        `/api/admin/journal`,
        null,
        authHeaders(luna),
      );
      await expect(response, 'to satisfy', {
        __httpCode: 200,
        actions: [
          {
            action_name: ACT_REMOVE_MODERATOR_RIGHTS,
            admin_username: luna.username,
            target_username: mars.username,
            details: {},
          },
        ],
        isLastPage: true,
      });
    });

    it(`should return members list without Mars`, async () => {
      const response = await performJSONRequest(
        'GET',
        `/api/admin/members`,
        null,
        authHeaders(luna),
      );
      await expect(response, 'to satisfy', {
        __httpCode: 200,
        users: [{ id: luna.user.id, roles: [ROLE_ADMIN] }],
      });
    });

    it('should make Mars moderator again', async () => {
      const response = await performJSONRequest(
        'POST',
        `/api/admin/members/${mars.username}/promote`,
        null,
        authHeaders(luna),
      );
      await expect(response, 'to satisfy', { __httpCode: 200, user: { roles: [ROLE_MODERATOR] } });
    });

    it(`should have record about it in journal`, async () => {
      const response = await performJSONRequest(
        'GET',
        `/api/admin/journal`,
        null,
        authHeaders(luna),
      );
      await expect(response, 'to satisfy', {
        __httpCode: 200,
        actions: [
          {
            action_name: ACT_GIVE_MODERATOR_RIGHTS,
            admin_username: luna.username,
            target_username: mars.username,
            details: {},
          },
          {
            action_name: ACT_REMOVE_MODERATOR_RIGHTS,
            admin_username: luna.username,
            target_username: mars.username,
            details: {},
          },
        ],
        isLastPage: true,
      });
    });
  });

  describe('Users freeze', () => {
    it(`should return empty list of frozen users`, async () => {
      const response = await performJSONRequest(
        'GET',
        `/api/admin/users/frozen`,
        null,
        authHeaders(mars),
      );
      await expect(response, 'to satisfy', {
        __httpCode: 200,
        frozen: [],
        users: [],
        isLastPage: true,
      });
    });

    it(`should not freeze user with invalid 'freezeUntil'`, async () => {
      const response = await performJSONRequest(
        'POST',
        `/api/admin/users/${venus.username}/freeze`,
        { freezeUntil: 'qwerty' },
        authHeaders(mars),
      );
      await expect(response, 'to satisfy', { __httpCode: 422 });
      await expect(await getUserInfo(venus, mars), 'to satisfy', {
        __httpCode: 200,
        user: { frozenUntil: null },
      });
    });

    it(`should not freeze user with 'freezeUntil' in the past`, async () => {
      const response = await performJSONRequest(
        'POST',
        `/api/admin/users/${venus.username}/freeze`,
        { freezeUntil: DateTime.now().minus({ days: 1 }).toISO() },
        authHeaders(mars),
      );
      await expect(response, 'to satisfy', { __httpCode: 422 });
    });

    it(`should freeze Venus with 'freezeUntil' in the future`, async () => {
      const response = await performJSONRequest(
        'POST',
        `/api/admin/users/${venus.username}/freeze`,
        { freezeUntil: 'P1D' },
        authHeaders(mars),
      );
      const now = await dbAdapter.now();

      await expect(response, 'to satisfy', { __httpCode: 200 });
      await expect(await getUserInfo(venus, mars), 'to satisfy', {
        __httpCode: 200,
        user: {
          frozenUntil: expect.it(
            'with date semantics',
            'to be close to',
            DateTime.fromJSDate(now).plus({ days: 1 }).toJSDate(),
          ),
        },
      });
    });

    it(`should have record about it in journal`, async () => {
      const response = await performJSONRequest(
        'GET',
        `/api/admin/journal?limit=1`,
        null,
        authHeaders(luna),
      );
      const now = await dbAdapter.now();

      await expect(response, 'to satisfy', {
        __httpCode: 200,
        actions: [
          {
            action_name: ACT_FREEZE_USER,
            admin_username: mars.username,
            target_username: venus.username,
            details: {
              freezeUntil: expect.it(
                'with date semantics',
                'to be close to',
                DateTime.fromJSDate(now).plus({ days: 1 }).toJSDate(),
              ),
            },
          },
        ],
        isLastPage: false,
      });
    });

    it(`should return Venus in list of frozen users`, async () => {
      const response = await performJSONRequest(
        'GET',
        `/api/admin/users/frozen`,
        null,
        authHeaders(mars),
      );
      const now = await dbAdapter.now();

      await expect(response, 'to satisfy', {
        __httpCode: 200,
        frozen: [
          {
            userId: venus.user.id,
            createdAt: expect.it('with date semantics', 'to be close to', now),
            expiresAt: expect.it(
              'with date semantics',
              'to be close to',
              DateTime.fromJSDate(now).plus({ days: 1 }).toJSDate(),
            ),
          },
        ],
        users: [{ id: venus.user.id }],
        isLastPage: true,
      });
    });

    it(`should unfreeze Venus`, async () => {
      const response = await performJSONRequest(
        'POST',
        `/api/admin/users/${venus.username}/unfreeze`,
        null,
        authHeaders(mars),
      );
      await expect(response, 'to satisfy', { __httpCode: 200 });
    });

    it(`should have record about it in journal`, async () => {
      const response = await performJSONRequest(
        'GET',
        `/api/admin/journal?limit=1`,
        null,
        authHeaders(luna),
      );

      await expect(response, 'to satisfy', {
        __httpCode: 200,
        actions: [
          {
            action_name: ACT_UNFREEZE_USER,
            admin_username: mars.username,
            target_username: venus.username,
            details: {},
          },
        ],
        isLastPage: false,
      });
    });

    it(`should not return Venus in list of frozen users`, async () => {
      const response = await performJSONRequest(
        'GET',
        `/api/admin/users/frozen`,
        null,
        authHeaders(mars),
      );

      await expect(response, 'to satisfy', {
        __httpCode: 200,
        frozen: [],
        users: [],
        isLastPage: true,
      });
    });
  });

  describe('Users list and user info', () => {
    it(`should return list of all users ordered by createdAt`, async () => {
      const sortedUsers = [venus, mars, luna];
      const response = await performJSONRequest('GET', `/api/admin/users`, null, authHeaders(mars));
      await expect(response, 'to satisfy', {
        __httpCode: 200,
        users: sortedUsers.map((c) => ({
          id: c.user.id,
          username: c.username,
          createdAt: c.user.createdAt,
          invitedBy: c.username === 'venus' ? 'luna' : null,
        })),
        isLastPage: true,
      });
    });

    it(`should return info about user`, async () => {
      const response = await getUserInfo(luna, mars);
      await expect(response, 'to satisfy', {
        __httpCode: 200,
        user: { id: luna.user.id },
      });
    });
  });

  describe('User suspend/unsuspend', () => {
    it(`should suspend Venus`, async () => {
      const response = await performJSONRequest(
        'POST',
        `/api/admin/users/${venus.username}/suspend`,
        null,
        authHeaders(mars),
      );
      await expect(response, 'to satisfy', { __httpCode: 200 });
      await expect(await getUserInfo(venus, mars), 'to satisfy', {
        __httpCode: 200,
        user: { goneStatus: 'SUSPENDED' },
      });
    });

    it(`should have record about it in journal`, async () => {
      const response = await performJSONRequest(
        'GET',
        `/api/admin/journal?limit=1`,
        null,
        authHeaders(luna),
      );

      await expect(response, 'to satisfy', {
        __httpCode: 200,
        actions: [
          {
            action_name: ACT_SUSPEND_USER,
            admin_username: mars.username,
            target_username: venus.username,
            details: {},
          },
        ],
        isLastPage: false,
      });
    });

    it(`should unsuspend Venus`, async () => {
      const response = await performJSONRequest(
        'POST',
        `/api/admin/users/${venus.username}/unsuspend`,
        null,
        authHeaders(mars),
      );
      await expect(response, 'to satisfy', { __httpCode: 200 });
      await expect(await getUserInfo(venus, mars), 'to satisfy', {
        __httpCode: 200,
        user: { goneStatus: 'ACTIVE' },
      });
    });

    it(`should have record about it in journal`, async () => {
      const response = await performJSONRequest(
        'GET',
        `/api/admin/journal?limit=1`,
        null,
        authHeaders(luna),
      );

      await expect(response, 'to satisfy', {
        __httpCode: 200,
        actions: [
          {
            action_name: ACT_UNSUSPEND_USER,
            admin_username: mars.username,
            target_username: venus.username,
            details: {},
          },
        ],
        isLastPage: false,
      });
    });

    it(`should not allow to unsuspend active Venus`, async () => {
      const response = await performJSONRequest(
        'POST',
        `/api/admin/users/${venus.username}/unsuspend`,
        null,
        authHeaders(mars),
      );
      await expect(response, 'to satisfy', { __httpCode: 422, err: /not in SUSPENDED status/ });
    });
  });

  describe('Disable/enable invites for user', () => {
    it(`should disable invites for Venus`, async () => {
      const response = await performJSONRequest(
        'POST',
        `/api/admin/users/${venus.username}/disable-invites`,
        null,
        authHeaders(mars),
      );
      await expect(response, 'to satisfy', { __httpCode: 200 });
      await expect(await venus.user.isInvitesDisabled(), 'to be true');
    });

    it(`should have record about it in journal`, async () => {
      const response = await performJSONRequest(
        'GET',
        `/api/admin/journal?limit=1`,
        null,
        authHeaders(luna),
      );

      await expect(response, 'to satisfy', {
        __httpCode: 200,
        actions: [
          {
            action_name: ACT_DISABLE_INVITES_FOR_USER,
            admin_username: mars.username,
            target_username: venus.username,
            details: {},
          },
        ],
        isLastPage: false,
      });
    });

    it(`should enable invites for Venus`, async () => {
      const response = await performJSONRequest(
        'POST',
        `/api/admin/users/${venus.username}/enable-invites`,
        null,
        authHeaders(mars),
      );
      await expect(response, 'to satisfy', { __httpCode: 200 });
      await expect(await venus.user.isInvitesDisabled(), 'to be false');
    });

    it(`should have record about it in journal`, async () => {
      const response = await performJSONRequest(
        'GET',
        `/api/admin/journal?limit=1`,
        null,
        authHeaders(luna),
      );

      await expect(response, 'to satisfy', {
        __httpCode: 200,
        actions: [
          {
            action_name: ACT_ENABLE_INVITES_FOR_USER,
            admin_username: mars.username,
            target_username: venus.username,
            details: {},
          },
        ],
        isLastPage: false,
      });
    });

    it(`should not enable invites for Venus twice`, async () => {
      const response = await performJSONRequest(
        'POST',
        `/api/admin/users/${venus.username}/enable-invites`,
        null,
        authHeaders(mars),
      );
      await expect(response, 'to satisfy', { __httpCode: 422 });
    });
  });

  describe('Site administrator target policy', () => {
    const policyErr = 'Site administrators cannot be frozen or suspended.';

    const getLatestActionId = async () => {
      const journal = await performJSONRequest(
        'GET',
        `/api/admin/journal?limit=1`,
        null,
        authHeaders(mars),
      );
      await expect(journal, 'to satisfy', { __httpCode: 200 });
      const { actions } = journal as { actions?: { id: string }[] };
      return actions?.[0]?.id ?? null;
    };

    it(`should still deny freeze/suspend to ordinary users (existing authorization)`, async () => {
      const freezeResp = await performJSONRequest(
        'POST',
        `/api/admin/users/${mars.username}/freeze`,
        { freezeUntil: 'P1D' },
        authHeaders(venus),
      );
      await expect(freezeResp, 'to satisfy', { __httpCode: 403 });
      const suspendResp = await performJSONRequest(
        'POST',
        `/api/admin/users/${venus.username}/suspend`,
        null,
        authHeaders(venus),
      );
      await expect(suspendResp, 'to satisfy', { __httpCode: 403 });
    });

    it(`should not let a moderator freeze a site administrator via direct request`, async () => {
      const journalIdBefore = await getLatestActionId();

      let response: unknown = null;
      let info: unknown = null;
      let journalIdAfter: unknown = null;
      let whoami: unknown = null;

      try {
        response = await performJSONRequest(
          'POST',
          `/api/admin/users/${luna.username}/freeze`,
          { freezeUntil: 'P1D' },
          authHeaders(mars),
        );
        info = await getUserInfo(luna, mars);
        journalIdAfter = await getLatestActionId();
        whoami = await performJSONRequest('GET', `/api/admin/whoami`, null, authHeaders(luna));
      } finally {
        // Restore pre-test state when the guard is absent (RED); audit-free model call
        await luna.user.freeze('P0D');
      }

      await expect(response, 'to satisfy', { __httpCode: 403, err: policyErr });
      await expect(info, 'to satisfy', { __httpCode: 200, user: { frozenUntil: null } });
      await expect(journalIdAfter, 'to be', journalIdBefore);
      await expect(whoami, 'to satisfy', { __httpCode: 200, user: { id: luna.user.id } });
    });

    it(`should not let a moderator suspend a site administrator via direct request`, async () => {
      const journalIdBefore = await getLatestActionId();
      const { globalUserUpdate } = PubSub;
      let userUpdates = 0;
      PubSub.globalUserUpdate = (async (...args: Parameters<typeof globalUserUpdate>) => {
        userUpdates += 1;
        await globalUserUpdate.apply(PubSub, args);
      }) as typeof globalUserUpdate;

      let response: unknown = null;
      let info: unknown = null;
      let journalIdAfter: unknown = null;

      try {
        response = await performJSONRequest(
          'POST',
          `/api/admin/users/${luna.username}/suspend`,
          null,
          authHeaders(mars),
        );
        info = await getUserInfo(luna, mars);
        journalIdAfter = await getLatestActionId();
      } finally {
        PubSub.globalUserUpdate = globalUserUpdate;
        // Restore pre-test state when the guard is absent (RED); publishes outside the spy window
        await luna.user.setGoneStatus(null);
      }

      await expect(response, 'to satisfy', { __httpCode: 403, err: policyErr });
      await expect(info, 'to satisfy', { __httpCode: 200, user: { goneStatus: 'ACTIVE' } });
      await expect(journalIdAfter, 'to be', journalIdBefore);
      await expect(userUpdates, 'to be', 0);
    });

    it(`should still let a moderator freeze and suspend another moderator`, async () => {
      await dbAdapter.setUserAdminRole(venus.user.id, ROLE_MODERATOR, true);

      const freezeResp = await performJSONRequest(
        'POST',
        `/api/admin/users/${venus.username}/freeze`,
        { freezeUntil: 'P1D' },
        authHeaders(mars),
      );
      await expect(freezeResp, 'to satisfy', { __httpCode: 200 });
      await expect(await getUserInfo(venus, mars), 'to satisfy', {
        __httpCode: 200,
        user: { frozenUntil: expect.it('to be a string') },
      });

      const unfreezeResp = await performJSONRequest(
        'POST',
        `/api/admin/users/${venus.username}/unfreeze`,
        null,
        authHeaders(mars),
      );
      await expect(unfreezeResp, 'to satisfy', { __httpCode: 200 });

      const suspendResp = await performJSONRequest(
        'POST',
        `/api/admin/users/${venus.username}/suspend`,
        null,
        authHeaders(mars),
      );
      await expect(suspendResp, 'to satisfy', { __httpCode: 200 });
      await expect(await getUserInfo(venus, mars), 'to satisfy', {
        __httpCode: 200,
        user: { goneStatus: 'SUSPENDED' },
      });

      const unsuspendResp = await performJSONRequest(
        'POST',
        `/api/admin/users/${venus.username}/unsuspend`,
        null,
        authHeaders(mars),
      );
      await expect(unsuspendResp, 'to satisfy', { __httpCode: 200 });
      await expect(await getLatestActionId(), 'not to be', null);
    });

    it(`should not let an admin+moderator freeze or suspend a site administrator, including self`, async () => {
      await dbAdapter.setUserAdminRole(mars.user.id, ROLE_ADMIN, true, {
        YES_I_WANT_TO_SET_ADMIN_FOR_TEST_ONLY: true,
      });

      const journalIdBefore = await getLatestActionId();

      let freezeLuna: unknown = null;
      let suspendLuna: unknown = null;
      let freezeSelf: unknown = null;
      let suspendSelf: unknown = null;
      let lunaInfo: unknown = null;
      let marsInfo: unknown = null;
      let journalIdAfter: unknown = null;

      try {
        freezeLuna = await performJSONRequest(
          'POST',
          `/api/admin/users/${luna.username}/freeze`,
          { freezeUntil: 'P1D' },
          authHeaders(mars),
        );
        suspendLuna = await performJSONRequest(
          'POST',
          `/api/admin/users/${luna.username}/suspend`,
          null,
          authHeaders(mars),
        );
        freezeSelf = await performJSONRequest(
          'POST',
          `/api/admin/users/${mars.username}/freeze`,
          { freezeUntil: 'P1D' },
          authHeaders(mars),
        );
        suspendSelf = await performJSONRequest(
          'POST',
          `/api/admin/users/${mars.username}/suspend`,
          null,
          authHeaders(mars),
        );

        lunaInfo = await getUserInfo(luna, mars);
        marsInfo = await getUserInfo(mars, mars);
        // Raw read: the actor may lock itself out when the guard is absent (RED)
        const journalAfter = await performJSONRequest(
          'GET',
          `/api/admin/journal?limit=1`,
          null,
          authHeaders(mars),
        );
        const { actions } = journalAfter as { actions?: { id: string }[] };
        journalIdAfter = actions?.[0]?.id ?? null;
      } finally {
        // Restore pre-test state when the guard is absent (RED); audit-free model calls
        await luna.user.freeze('P0D');
        await mars.user.freeze('P0D');
        await luna.user.setGoneStatus(null);
        await mars.user.setGoneStatus(null);
      }

      await expect(freezeLuna, 'to satisfy', { __httpCode: 403, err: policyErr });
      await expect(suspendLuna, 'to satisfy', { __httpCode: 403, err: policyErr });
      await expect(freezeSelf, 'to satisfy', { __httpCode: 403, err: policyErr });
      await expect(suspendSelf, 'to satisfy', { __httpCode: 403, err: policyErr });

      await expect(lunaInfo, 'to satisfy', {
        __httpCode: 200,
        user: { frozenUntil: null, goneStatus: 'ACTIVE' },
      });
      await expect(marsInfo, 'to satisfy', {
        __httpCode: 200,
        user: { frozenUntil: null, goneStatus: 'ACTIVE' },
      });
      await expect(journalIdAfter, 'to be', journalIdBefore);
    });

    it(`should still let a moderator unfreeze a previously locked administrator`, async () => {
      await luna.user.freeze('P1D');
      await expect(await luna.user.isFrozen(), 'to be true');

      const response = await performJSONRequest(
        'POST',
        `/api/admin/users/${luna.username}/unfreeze`,
        null,
        authHeaders(mars),
      );
      await expect(response, 'to satisfy', { __httpCode: 200 });
      await expect(await getUserInfo(luna, mars), 'to satisfy', {
        __httpCode: 200,
        user: { frozenUntil: null },
      });
      const journal = await performJSONRequest(
        'GET',
        `/api/admin/journal?limit=1`,
        null,
        authHeaders(mars),
      );
      await expect(journal, 'to satisfy', {
        __httpCode: 200,
        actions: [
          {
            action_name: ACT_UNFREEZE_USER,
            admin_username: mars.username,
            target_username: luna.username,
          },
        ],
      });
    });

    it(`should still let a moderator unsuspend a previously locked administrator`, async () => {
      await luna.user.setGoneStatus(GONE_SUSPENDED);
      await expect(await getUserInfo(luna, mars), 'to satisfy', {
        __httpCode: 200,
        user: { goneStatus: 'SUSPENDED' },
      });

      const response = await performJSONRequest(
        'POST',
        `/api/admin/users/${luna.username}/unsuspend`,
        null,
        authHeaders(mars),
      );
      await expect(response, 'to satisfy', { __httpCode: 200 });
      await expect(await getUserInfo(luna, mars), 'to satisfy', {
        __httpCode: 200,
        user: { goneStatus: 'ACTIVE' },
      });
      const journal = await performJSONRequest(
        'GET',
        `/api/admin/journal?limit=1`,
        null,
        authHeaders(mars),
      );
      await expect(journal, 'to satisfy', {
        __httpCode: 200,
        actions: [
          {
            action_name: ACT_UNSUSPEND_USER,
            admin_username: mars.username,
            target_username: luna.username,
          },
        ],
      });
    });

    it(`should keep invite restrictions for administrators unchanged`, async () => {
      const disableResp = await performJSONRequest(
        'POST',
        `/api/admin/users/${luna.username}/disable-invites`,
        null,
        authHeaders(mars),
      );
      await expect(disableResp, 'to satisfy', { __httpCode: 200 });
      const enableResp = await performJSONRequest(
        'POST',
        `/api/admin/users/${luna.username}/enable-invites`,
        null,
        authHeaders(mars),
      );
      await expect(enableResp, 'to satisfy', { __httpCode: 200 });
    });
  });
});

function getUserInfo(userCtx: UserCtx, reqUserCtx: UserCtx | null = null) {
  return performJSONRequest(
    'GET',
    `/api/admin/users/${userCtx.username}/info`,
    null,
    authHeaders(reqUserCtx),
  );
}
