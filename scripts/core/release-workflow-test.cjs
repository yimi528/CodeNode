'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateTag } = require('../validate-release-tag.cjs');

const root = path.resolve(__dirname, '../..');
const pkg = require(path.join(root, 'package.json'));
const workflow = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');

assert.equal(validateTag(`v${pkg.version}`), `v${pkg.version}`);
assert.throws(() => validateTag(pkg.version), /格式无效/);
assert.throws(() => validateTag('v999.0.0'), /不一致/);
assert.match(workflow, /tags:\s*\n\s*- 'v\*'/, 'release workflow must run from version tags');
assert.match(workflow, /validate-release-tag\.cjs/, 'release workflow must validate tag and package version');
assert.match(workflow, /git fetch origin main/, 'release workflow must fetch the stable branch for ancestry validation');
for (const platform of ['win', 'mac', 'linux']) assert.match(workflow, new RegExp(`platform: ${platform}`));
assert.match(workflow, /CODENODE_REQUIRE_SIGNING:\s*'1'/, 'Windows release must fail closed without a valid signature');
assert.match(workflow, /CODENODE_WIN_CERT_PFX_BASE64/, 'Windows signing certificate must come from a secret');
assert.match(workflow, /SHA256SUMS\.txt/, 'published assets must include a cross-platform hash manifest');
assert.match(workflow, /gh release create/, 'workflow must create a GitHub Release');
assert.match(workflow, /contents:\s*write/, 'only the publish job may receive release write permission');

console.log('RELEASE WORKFLOW: PASS (tag/version/main gate, three platforms, signing fail-closed, checksums, GitHub Release)');
