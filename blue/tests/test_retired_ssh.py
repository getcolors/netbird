import pytest
from package_netbird_blue import tools

@pytest.mark.parametrize('event,retired,expected',[('delete',True,False),('delete',False,True),('create',True,True),('create',False,True)])
async def test_retired_delete_ignores_stale_host(monkeypatch,tmp_path,event,retired,expected):
    calls=[]
    monkeypatch.setattr(tools,'ansible_specs',lambda opts:[])
    async def ansible(opts,*args,**kwargs):calls.append(opts);return {**opts,'blue/exit':0}
    monkeypatch.setattr(tools,'ansible_with_spec',ansible)
    result=await tools.ansible_step({'profile':'test','workdir':str(tmp_path),'blue/event':event,'netbird/already-destroyed':retired,'ip':'203.0.113.19','ssh-private-key-path':str(tmp_path/'removed-key')})
    assert bool(calls)==expected
    assert result['blue/exit']==0
    assert not list(tmp_path.iterdir())
