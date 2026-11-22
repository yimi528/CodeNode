'use strict';
if (!process.env.CODENODE_PACKAGED_ASAR) throw new Error('CODENODE_PACKAGED_ASAR is required');

// Exercise the same live switching and badge checks using the packaged app.
require('../ui/streaming-ui-test.cjs');
