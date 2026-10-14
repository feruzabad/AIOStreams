import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// Load the core entry point first; config.ts and the services import each other.
import '../index.js';
import { mergeParentChain } from './config.js';
import { APIError, ErrorCode } from './constants.js';
import type { UserData } from '../db/schemas.js';

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Config `n`, whose parent is `parent` (if any), with the given strategies. */
function config(
  n: number,
  parent?: number,
  extra: Partial<UserData> = {},
  strategies: Record<string, string> = {}
): UserData {
  return {
    uuid: uuid(n),
    addonName: `config ${n}`,
    presets: [],
    services: [],
    ...(parent !== undefined && {
      parentConfig: {
        uuid: uuid(parent),
        password: `password ${parent}`,
        mergeStrategies: strategies,
      },
    }),
    ...extra,
  } as unknown as UserData;
}

const preset = (instanceId: string) =>
  ({ type: 'torz', instanceId, enabled: true, options: {} }) as any;

/** Loads configs from `store`, checking each is asked for with its own password. */
function loader(store: UserData[]) {
  const loaded: string[] = [];
  const load = async (id: string, password: string) => {
    const found = store.find((c) => c.uuid === id);
    if (!found) throw new Error('not found');
    if (password !== `password ${Number(id.slice(-12))}`)
      throw new Error('wrong password');
    loaded.push(id);
    return structuredClone(found);
  };
  return { load, loaded };
}

const rejectsWith = (code: ErrorCode) => (error: unknown) =>
  error instanceof APIError && error.code === code;

describe('mergeParentChain', () => {
  it('returns a config without a parent as it is', async () => {
    const own = config(1);
    const { load, loaded } = loader([]);
    assert.equal(await mergeParentChain(own, load, { maxDepth: 5 }), own);
    assert.deepEqual(loaded, []);
  });

  it('inherits from a parent', async () => {
    const parent = config(2, undefined, { presets: [preset('a')] });
    const { load } = loader([parent]);
    const merged = await mergeParentChain(config(1, 2), load, { maxDepth: 5 });
    assert.deepEqual(
      merged.presets?.map((p) => p.instanceId),
      ['a']
    );
  });

  it("inherits from a parent's parent", async () => {
    const grandparent = config(3, undefined, {
      presets: [preset('a')],
      services: [{ id: 'torbox', enabled: true, credentials: {} }] as any,
    });
    const { load, loaded } = loader([config(2, 3), grandparent]);
    const merged = await mergeParentChain(config(1, 2), load, { maxDepth: 5 });
    assert.deepEqual(
      merged.presets?.map((p) => p.instanceId),
      ['a']
    );
    assert.deepEqual(
      merged.services?.map((s) => s.id),
      ['torbox']
    );
    assert.deepEqual(loaded, [uuid(2), uuid(3)]);
  });

  it('applies each level its own merge strategies, oldest first', async () => {
    const grandparent = config(3, undefined, { presets: [preset('a')] });
    // The parent adds its own addon to the grandparent's...
    const parent = config(
      2,
      3,
      { presets: [preset('b')] },
      { presets: 'extend' }
    );
    // ...and the config adds one more to both.
    const own = config(1, 2, { presets: [preset('c')] }, { presets: 'extend' });
    const { load } = loader([parent, grandparent]);
    const merged = await mergeParentChain(own, load, { maxDepth: 5 });
    assert.deepEqual(
      merged.presets?.map((p) => p.instanceId),
      ['a', 'b', 'c']
    );
  });

  it('stops at a level that overrides', async () => {
    const grandparent = config(3, undefined, { presets: [preset('a')] });
    const parent = config(
      2,
      3,
      { presets: [preset('b')] },
      { presets: 'override' }
    );
    const { load } = loader([parent, grandparent]);
    const merged = await mergeParentChain(config(1, 2), load, { maxDepth: 5 });
    assert.deepEqual(
      merged.presets?.map((p) => p.instanceId),
      ['b']
    );
  });

  it('keeps the config itself on top', async () => {
    const { load } = loader([config(2, 3), config(3)]);
    const merged = await mergeParentChain(config(1, 2), load, { maxDepth: 5 });
    assert.equal(merged.uuid, uuid(1));
    assert.equal(merged.parentConfig?.uuid, uuid(2));
  });

  it('is trusted when any config in the chain is', async () => {
    const grandparent = config(3, undefined, { trusted: true });
    const { load } = loader([config(2, 3), grandparent]);
    const merged = await mergeParentChain(config(1, 2), load, { maxDepth: 5 });
    assert.equal(merged.trusted, true);
  });

  it('follows up to maxDepth parents', async () => {
    // 1 -> 2 -> 3 -> 4 -> 5 -> 6: five parents.
    const store = [2, 3, 4, 5].map((n) => config(n, n + 1));
    store.push(config(6, undefined, { presets: [preset('top')] }));
    const { load } = loader(store);
    const merged = await mergeParentChain(config(1, 2), load, { maxDepth: 5 });
    assert.deepEqual(
      merged.presets?.map((p) => p.instanceId),
      ['top']
    );
  });

  it('rejects a chain longer than maxDepth', async () => {
    // 1 -> ... -> 7: six parents.
    const store = [2, 3, 4, 5, 6].map((n) => config(n, n + 1));
    store.push(config(7));
    const { load, loaded } = loader(store);
    await assert.rejects(
      mergeParentChain(config(1, 2), load, { maxDepth: 5 }),
      rejectsWith(ErrorCode.PARENT_CONFIG_TOO_DEEP)
    );
    assert.equal(loaded.length, 5);
  });

  it('rejects a chain that leads back to the config', async () => {
    const { load } = loader([config(2, 3), config(3, 1)]);
    await assert.rejects(
      mergeParentChain(config(1, 2), load, { uuid: uuid(1), maxDepth: 5 }),
      rejectsWith(ErrorCode.PARENT_CONFIG_CYCLE)
    );
  });

  it('rejects a loop between parents', async () => {
    const { load, loaded } = loader([config(2, 3), config(3, 2)]);
    await assert.rejects(
      mergeParentChain(config(1, 2), load, { maxDepth: 5 }),
      rejectsWith(ErrorCode.PARENT_CONFIG_CYCLE)
    );
    assert.deepEqual(loaded, [uuid(2), uuid(3)]);
  });

  it('rejects a parent that cannot be loaded, at any level', async () => {
    const { load } = loader([config(2, 3)]);
    await assert.rejects(
      mergeParentChain(config(1, 2), load, { maxDepth: 5 }),
      rejectsWith(ErrorCode.PARENT_CONFIG_UNAVAILABLE)
    );
  });
});
