import {mkdir,cp,rm} from 'node:fs/promises';
await rm(new URL('./dist',import.meta.url),{recursive:true,force:true});await mkdir(new URL('./dist',import.meta.url));
for(const file of ['index.html','app.js','config.js'])await cp(new URL(file,import.meta.url),new URL('dist/'+file,import.meta.url));
await cp(new URL('../art',import.meta.url),new URL('./dist/art',import.meta.url),{recursive:true});
