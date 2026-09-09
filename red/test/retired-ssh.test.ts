import {test,expect,spyOn} from 'bun:test';
import * as tools from '../src/tools.ts';
import * as ansible from 'red/ansible';
for(const event of ['delete','create'])for(const retired of [true,false])test(`retired ${retired} ${event} with stale IP`,async()=>{
 const specs=spyOn(tools,'ansibleSpecs').mockReturnValue([]);
 const remote=spyOn(ansible,'ansibleWithSpec').mockImplementation(async(opts)=>({...opts,'red/exit':0}));
 try{const result=await tools.ansibleStep({'profile':'test','workdir':'/tmp/unused-retired-test','red/event':event,'netbird/already-destroyed':retired,ip:'203.0.113.19','ssh-private-key-path':'/tmp/removed-key'});expect(result['red/exit']).toBe(0);expect(remote.mock.calls.length).toBe(event==='delete'&&retired?0:1);}finally{specs.mockRestore();remote.mockRestore();}
});
