import { before, beforeEach, describe, it } from 'mocha';
import expect from 'unexpected';

import { getSingleton } from '../../app/app';
import { dbAdapter } from '../../app/models';
import type PubsubListener from '../../app/pubsub-listener';
import { eventNames } from '../../app/support/PubSubAdapter';
import cleanDB from '../dbCleaner';

import {
  type UserCtx,
  createTestUsers,
  justCreateComment,
  justCreatePost,
} from './functional_test_helper';

describe('Realtime deleted comment updates', () => {
  let luna: UserCtx;
  let listener: PubsubListener;

  before(async () => {
    const app = await getSingleton();
    listener = app.context.pubsub;
  });

  beforeEach(async () => {
    await cleanDB(dbAdapter.database);
    [luna] = await createTestUsers(['luna']);
  });

  const captureBroadcasts = () => {
    const original = listener.broadcastMessage;
    const types: string[] = [];

    listener.broadcastMessage = async (...args: unknown[]) => {
      types.push(args[1] as string);
      await original.call(listener, ...args);
    };

    return {
      types,
      restore: () => {
        listener.broadcastMessage = original;
      },
    };
  };

  it('should not broadcast comment:update for a comment marked for deletion', async () => {
    const post = await justCreatePost(luna, 'Luna post');
    const comment = await justCreateComment(luna, post.id, 'Luna comment');

    await comment.inactivate();

    const reloaded = await dbAdapter.getCommentById(comment.id);
    expect(reloaded?.toDelete, 'to be true');

    const { types, restore } = captureBroadcasts();

    try {
      // An update event queued before deletion, handled after it
      await listener.onCommentUpdate({ commentId: comment.id });
    } finally {
      restore();
    }

    expect(
      types.filter((t) => t === eventNames.COMMENT_UPDATED),
      'to be empty',
    );
  });

  it('should not broadcast comment:update for a nonexistent comment', async () => {
    const { types, restore } = captureBroadcasts();

    try {
      await listener.onCommentUpdate({ commentId: '00000000-0000-4000-8000-000000000000' });
    } finally {
      restore();
    }

    expect(
      types.filter((t) => t === eventNames.COMMENT_UPDATED),
      'to be empty',
    );
  });

  it('should broadcast comment:update for an active comment', async () => {
    const post = await justCreatePost(luna, 'Luna post');
    const comment = await justCreateComment(luna, post.id, 'Luna comment');

    const { types, restore } = captureBroadcasts();

    try {
      await listener.onCommentUpdate({ commentId: comment.id });
    } finally {
      restore();
    }

    expect(types, 'to contain', eventNames.COMMENT_UPDATED);
  });
});
