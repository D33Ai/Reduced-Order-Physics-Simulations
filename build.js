#!/usr/bin/env node
/* Inlines src/* and the DEM asset into a single self-contained offline HTML file. */
"use strict";
const fs=require('fs'), path=require('path');
const R=d=>fs.readFileSync(path.join(__dirname,d),'utf8');
const out=path.join(__dirname,'dist','lunar_cargo_mission_v7.html');
const parts={
  '/*<<<STYLE>>>*/':   R('src/style.css'),
  '/*<<<DEM>>>*/':     R('assets/dem_south_pole_512.js'),
  '/*<<<CORE>>>*/':    R('src/core.js'),
  '/*<<<GLSL>>>*/':    R('src/glsl.js'),
  '/*<<<GFX>>>*/':     R('src/gfx.js'),
  '/*<<<MISSION>>>*/': R('src/mission.js')
};
let html=R('src/index.html');
for(const [k,v] of Object.entries(parts)){
  if(!html.includes(k)) throw new Error('template marker missing: '+k);
  html=html.replace(k,()=>v);
}
if(/<\/script>/i.test(parts['/*<<<CORE>>>*/']+parts['/*<<<MISSION>>>*/']))
  throw new Error('source contains </script> — would break the inline bundle');
fs.mkdirSync(path.dirname(out),{recursive:true});
fs.writeFileSync(out,html);
const kb=(Buffer.byteLength(html)/1024).toFixed(0);
console.log('built '+path.relative(__dirname,out)+'  ('+kb+' KB)');
