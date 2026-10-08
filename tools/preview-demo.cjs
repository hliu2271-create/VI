'use strict';
const http=require('node:http'),path=require('node:path'),serve=require('../server/static-files');
const root=path.resolve(__dirname,'..',process.env.DEMO_DIRECTORY||'dist');
http.createServer((req,res)=>{let pathname;try{pathname=new URL(req.url,'http://localhost').pathname;}catch{res.writeHead(400);return res.end();}if(serve(req,res,pathname,root))return;res.writeHead(404,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:false,error:'Not found'}));}).listen(Number(process.env.PORT)||34888,'127.0.0.1',()=>console.log('Demo preview: http://127.0.0.1:'+(process.env.PORT||34888)));
