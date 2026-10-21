'use strict';

const { copyFileSync, mkdirSync } = require('node:fs');
const { dirname, join } = require('node:path');

const outputDirectory = join(__dirname, '..', 'media', 'vendor');
mkdirSync(outputDirectory, { recursive: true });
copyFileSync(join(dirname(require.resolve('marked')), 'marked.umd.js'), join(outputDirectory, 'marked.js'));
copyFileSync(join(dirname(require.resolve('dompurify')), 'purify.min.js'), join(outputDirectory, 'purify.js'));
