import { strict as assert } from 'node:assert';
import test from 'node:test';

import { parsePyTorchHeader, unpickle } from '../extension/pytorch-parser.js';

function getPathValue(root: unknown, path: string): unknown {
  return path.split('/').filter(Boolean).reduce<unknown>((current, segment) => {
    if (Array.isArray(current)) return current[Number(segment)];
    if (current && typeof current === 'object') return (current as Record<string, unknown>)[segment];
    return undefined;
  }, root);
}

test('unpickle decodes BINFLOAT as big-endian IEEE-754 double', () => {
  const payload = Buffer.concat([
    Buffer.from([0x80, 0x02, 0x47]),
    Buffer.from('3ef4f8b588e368f1', 'hex'),
    Buffer.from([0x2e]),
  ]);

  assert.equal(unpickle(payload), 2e-05);
});

test('parsePyTorchCheckpoint preserves pickle BINFLOAT optimizer args', () => {
  const checkpoint = parsePyTorchHeader('test/pickle-binfloat-lr.pth');

  assert.equal(getPathValue(checkpoint.data, '/args/lr'), 2e-05);
  assert.equal(getPathValue(checkpoint.data, '/args/weight_decay'), 0.02);
  assert.equal(getPathValue(checkpoint.data, '/args/eps'), 1e-08);
  assert.equal(getPathValue(checkpoint.data, '/args/betas/0'), 0.9);
  assert.equal(getPathValue(checkpoint.data, '/args/betas/1'), 0.95);
});
