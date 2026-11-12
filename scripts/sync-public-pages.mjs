import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
const root=path.resolve(import.meta.dirname,'..'),cache=new Map();
function url(file){if(cache.has(file))return cache.get(file);const js=ts.transpileModule(fs.readFileSync(file,'utf8'),{fileName:file,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace(/(from\s+["'])(\.\.?\/[^"']+)(["'])/gu,(_,a,b,c)=>a+url(path.resolve(path.dirname(file),b+'.ts'))+c);const result='data:text/javascript;base64,'+Buffer.from(js).toString('base64');cache.set(file,result);return result;}
const {renderPublicPage}=await import(url(path.join(root,'src/lib/public-pages.ts')));
let mismatch=false;
for(const route of ['/','/about','/privacy','/terms']){const file=path.join(root,'public',route==='/'?'index.html':route.slice(1)+'.html'),content=renderPublicPage(route);if(process.argv.includes('--check')){if(!fs.existsSync(file)||fs.readFileSync(file,'utf8')!==content){console.error('Public page out of sync: '+route);mismatch=true;}}else fs.writeFileSync(file,content);}
if(mismatch)process.exitCode=1;else console.log('Public identity and policy pages '+(process.argv.includes('--check')?'match source.':'generated.'));
