// Real electron-updater provider, HTTP download and SHA512 checks; native installer is mocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import http from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createUpdateCoordinator} from '../runtime/desktop/updater.mjs';
const require=createRequire(import.meta.url);
test('real macOS updater checks a two-version HTTP feed, verifies/downloads ZIP, and defers active work without native installation',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'crew-update-feed-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const native=new EventEmitter();let nativeChecks=0,nativeInstalls=0;native.setFeedURL=()=>{};native.checkForUpdates=()=>{nativeChecks++;};native.quitAndInstall=()=>{nativeInstalls++;};
 const electronPath=require.resolve('electron'),previous=require.cache[electronPath];require.cache[electronPath]={id:electronPath,filename:electronPath,loaded:true,exports:{autoUpdater:native}};t.after(()=>{if(previous)require.cache[electronPath]=previous;else delete require.cache[electronPath];});
 const {MacUpdater}=require('electron-updater');const {NodeHttpExecutor}=require('builder-util/out/nodeHttpExecutor');const {ElectronHttpExecutor}=require('electron-updater/out/electronHttpExecutor');
 const zip=Buffer.concat([Buffer.from('PK\x03\x04fixture ZIP download only\n'),Buffer.alloc(32768,42)]),sha512=createHash('sha512').update(zip).digest('base64');let corrupted=false;
 const server=http.createServer((request,response)=>{if(request.url.startsWith('/latest-mac.yml')){response.setHeader('Content-Type','application/yaml');response.end(`version: 0.9.1\nfiles:\n  - url: Crew-0.9.1-arm64.zip\n    sha512: ${corrupted?Buffer.alloc(64).toString('base64'):sha512}\n    size: ${zip.length}\nreleaseDate: '2026-01-01T00:00:00.000Z'\n`);}else if(request.url==='/Crew-0.9.1-arm64.zip'){response.setHeader('Content-Length',zip.length);response.end(zip);}else{response.statusCode=404;response.end();}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));const url=`http://127.0.0.1:${server.address().port}`;
 async function updaterFor(suffix){const folder=path.join(root,suffix);await mkdir(folder);const config=path.join(folder,'app-update.yml');await writeFile(config,`provider: generic\nurl: ${url}\nupdaterCacheDirName: cache\n`);const updater=new MacUpdater(undefined,{version:'0.9.0',name:'CrewFixture',isPackaged:true,appUpdateConfigPath:config,userDataPath:folder,baseCachePath:folder,whenReady:async()=>{}});updater.httpExecutor=new NodeHttpExecutor();updater.httpExecutor.download=ElectronHttpExecutor.prototype.download;updater.logger=null;updater.autoDownload=false;updater.autoInstallOnAppQuit=false;updater.disableDifferentialDownload=true;t.after(()=>updater.closeServerIfExists());return updater;}
 const updater=await updaterFor('valid');let safe=true,stopped=0;const coordinator=createUpdateCoordinator({updater,currentVersion:'0.9.0',support:{supported:true},activity:async()=>({safe,reasons:safe?[]:['A real task is active.']}),prepare:async()=>({reserved:true}),cancel:async()=>{},stopBackend:async()=>{stopped++;},install:async()=>{throw Error('Native installation is outside this fixture.');},lease:{acquire:async()=>async()=>{}}});
 assert.equal((await coordinator.request('check')).phase,'available');assert.equal(coordinator.getStatus().availableVersion,'0.9.1');await coordinator.request('download');assert.equal(coordinator.getStatus().phase,'downloaded');const downloaded=updater.downloadedUpdateHelper.file;assert.equal(createHash('sha512').update(await readFile(downloaded)).digest('base64'),sha512);
 safe=false;await assert.rejects(coordinator.request('restart'),/task is active/);assert.equal(stopped,0);assert.equal(nativeChecks,0);assert.equal(nativeInstalls,0);
 corrupted=true;const bad=await updaterFor('tampered');bad.on('error',()=>{});await bad.checkForUpdates();await assert.rejects(bad.downloadUpdate(),/checksum|sha512/i);assert.equal(nativeChecks,0);assert.equal(nativeInstalls,0);
});
