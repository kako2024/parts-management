/**
 * docs/app/ のソース（関数を切り出して隔離 VM で試すテスト用）。
 * all: index.html と同じ順につないだもの。byFile: ファイルごと（{ 'api.js': ... }）。切り出しをファイルの中で終えるときに使う
 */
const fs = require('fs');
const path = require('path');
const DOCS = path.join(__dirname, '..', 'docs');
const html = fs.readFileSync(path.join(DOCS, 'index.html'), 'utf8');
const files = [...html.matchAll(/<script src="(app\/[\w-]+\.js)"><\/script>/g)].map(m => m[1]);
if (!files.length) throw new Error('index.html に app/ のスクリプトがありません');
const byFile = Object.fromEntries(files.map(f => [path.basename(f), fs.readFileSync(path.join(DOCS, f), 'utf8')]));
module.exports = { all: Object.values(byFile).join('\n'), byFile };
