const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '../src/frontend/index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../src/frontend/styles.css'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '../src/frontend/app.js'), 'utf8');

const output = `// Auto-generated assets file for Sentinel Dashboard
export const HTML = ${JSON.stringify(html)};
export const CSS = ${JSON.stringify(css)};
export const JS = ${JSON.stringify(js)};
`;

fs.writeFileSync(path.join(__dirname, '../src/frontend_assets.ts'), output);
console.log('src/frontend_assets.ts generated successfully!');
