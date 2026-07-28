/**
 * Node identity has to survive the next hierarchy read, because that is the only thing the tree selection,
 * branch expansion and device highlight can hold on to (ADR-007).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assignNodeIdentity, findNodeByKey } from '../src/nodeIdentity.js';
import type { MobileNode } from '../src/types.js';

const screen = (): MobileNode[] => [
  {
    className: 'FrameLayout',
    children: [
      { className: 'Button', accessibilityId: 'login', text: 'Log in' },
      { className: 'TextView', text: 'Forgot?' },
    ],
  },
];

test('paths are the index chain from the root', () => {
  const [root] = assignNodeIdentity(screen());

  assert.equal(root.path, '0');
  assert.equal(root.children?.[0].path, '0/0');
  assert.equal(root.children?.[1].path, '0/1');
});

test('a re-read of the same screen produces the same keys', () => {
  const first = assignNodeIdentity(screen());
  const second = assignNodeIdentity(screen());

  assert.equal(first[0].children?.[0].key, second[0].children?.[0].key);
  assert.notEqual(first[0].children?.[0], second[0].children?.[0], 'but not the same object');
});

test('siblings that differ only by text get distinct keys', () => {
  const [root] = assignNodeIdentity([
    {
      className: 'Row',
      children: [
        { className: 'Text', text: 'a' },
        { className: 'Text', text: 'b' },
      ],
    },
  ]);

  assert.notEqual(root.children?.[0].key, root.children?.[1].key);
});

test('an identified node ignores its text, so a changing label keeps the key', () => {
  const withLabel = assignNodeIdentity([
    { className: 'Button', accessibilityId: 'cart', text: '1 item' },
  ]);
  const relabelled = assignNodeIdentity([
    { className: 'Button', accessibilityId: 'cart', text: '2 items' },
  ]);

  assert.equal(withLabel[0].key, relabelled[0].key);
});

test('assignNodeIdentity does not mutate its input', () => {
  const original = screen();

  assignNodeIdentity(original);

  assert.equal(original[0].key, undefined, 'an adapter may hand back a cached tree');
});

test('findNodeByKey re-resolves a remembered node at any depth', () => {
  const tree = assignNodeIdentity(screen());
  const key = tree[0].children?.[1].key;
  assert.ok(key);

  assert.equal(findNodeByKey(tree, key)?.text, 'Forgot?');
  assert.equal(findNodeByKey(tree, 'nope'), undefined);
});

test('a key still resolves after the tree is rebuilt — the point of the exercise', () => {
  const key = assignNodeIdentity(screen())[0].children?.[0].key;
  assert.ok(key);

  const afterPoll = assignNodeIdentity(screen());

  assert.equal(findNodeByKey(afterPoll, key)?.accessibilityId, 'login');
});
