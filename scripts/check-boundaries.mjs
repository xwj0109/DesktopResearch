import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const errors=[];
const dependencies=path.join(root,'node_modules');
if(fs.existsSync(dependencies)&&fs.lstatSync(dependencies).isSymbolicLink()) errors.push('node_modules must be owned by this repository, not linked to another project');
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
for(const name of Object.keys({...pkg.dependencies,...pkg.devDependencies})) if(/(?:^|\/)pi-(?:coding-agent|agent-core|ai)$/.test(name)) errors.push('Bundled Pi runtime dependency denied: '+name);
let checked=0;
function scan(dir){
 if(!fs.existsSync(dir))return;
 for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
  if(entry.name.startsWith('.'))continue;
  const file=path.join(dir,entry.name);
  if(entry.isSymbolicLink()){errors.push('Operational source symlink denied: '+path.relative(root,file));continue;}
  if(entry.isDirectory())scan(file);
  else if(/\.(?:ts|tsx|mjs|js)$/.test(entry.name)){
   checked++;
   const text=fs.readFileSync(file,'utf8');
   if(/(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'][^"']*(?:herdr-lab|phase10-readonly-review|desktop-design-)/.test(text))errors.push('Cross-repository runtime import: '+path.relative(root,file));
  }
 }
}
for(const dir of ['src','server','desktop','scripts','tests'])scan(path.join(root,dir));
if(errors.length){console.error(errors.join('\n'));process.exitCode=1;}
else console.log(`Repository boundaries passed (${checked} source files; no linked dependency tree or bundled Pi runtime).`);
