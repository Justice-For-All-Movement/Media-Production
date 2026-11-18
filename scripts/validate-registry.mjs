import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const registry = read('registry/prs.json');
const plan = read('docs/approved-design/development_backlog.json');
const catalog = read('docs/approved-design/engine_catalog.json');
assert.equal(plan.tasks.length, 122); assert.equal(catalog.engines.length, 15);
assert.equal(registry.repository, 'Justice-For-All-Movement/Media-Production');
assert.deepEqual(registry.units.map(u => [u.id, u.dependsOn]), plan.tasks.filter(t => t.engines.includes('E10')).map(t => [t.id, t.dependencies]));
for (const [name, expected] of Object.entries(registry.approvedDesignSha256)) {
  assert.equal(createHash('sha256').update(readFileSync('docs/approved-design/' + name)).digest('hex'), expected);
}
console.log('Original 15-engine/122-task public design and E10 IDs/dependencies preserved; integration acceptance remains separate.');
