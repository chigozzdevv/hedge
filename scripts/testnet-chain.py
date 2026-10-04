import concurrent.futures
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
from journal import JournalDirectory

ROOT = Path(__file__).resolve().parent.parent
RUN_NAME = os.environ.get('HEDGE_TESTNET_RUN', 'fast')
assert RUN_NAME in ['', 'fast'], 'Unknown testnet run'
BUILD_KEY = hashlib.sha256(('hedge-v3:'+':'.join(json.loads((ROOT/path).read_text())['bytecode']['object'] for path in ['packages/foundry/out/hedge-lending.sol/HedgeLending.json','packages/foundry/out/hedge-vault.sol/HedgeVault.json'])).encode()).hexdigest()[:16]
RUN_DIR = JournalDirectory()
BASE_CONFIRMATIONS = 5 if RUN_NAME == 'fast' else 0
CAPITAL_AMOUNT = 5*10**6 if RUN_NAME == 'fast' else 50*10**6
TOKEN = '0x0000000000000000000000000000000000001549'
ASSET = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
NETWORKS = {
    'hedera-testnet': {'rpc': 'https://testnet.hashio.io/api', 'chainId':296,
        'router':'0x802C5F84eAD128Ff36fD6a3f8a418e339f467Ce4',
        'selector':222782988166878823, 'remoteSelector':10344971235874465080,
        'remoteChainId':84532, 'artifact':'packages/foundry/out/hedge-lending.sol/HedgeLending.json'},
    'base-sepolia': {'rpc':'https://sepolia.base.org','chainId':84532,
        'router':'0xD3b06cEbF099CE7DA4AcCf578aaebFDBd6e88a93',
        'selector':10344971235874465080, 'remoteSelector':222782988166878823,
        'remoteChainId':296,'artifact':'packages/foundry/out/hedge-vault.sol/HedgeVault.json'}
}

app = Path(os.environ.get('HEDGE_APP_DIR', str(ROOT/'packages'/'nextjs')))
wallets=json.loads((app/'.hedge/wallets.json').read_text())
os.environ.setdefault('HEDGE_JOURNAL_SCOPE', 'deployment:'+str(app)+':'+wallets['hedera']['address'].lower()+':'+BUILD_KEY)
for network,config in NETWORKS.items():
    config['operator']=wallets['hedera' if network=='hedera-testnet' else 'base']['address']

def rpc(network, method, params):
    request=json.dumps({'jsonrpc':'2.0','id':1,'method':method,'params':params})
    response=subprocess.run(['curl','-fsS','--max-time','30',NETWORKS[network]['rpc'],
        '-H','content-type: application/json','--data-binary','@-'],input=request,
        text=True,capture_output=True,timeout=35,check=True)
    result=json.loads(response.stdout)
    if 'error' in result:
        raise RuntimeError(method+': '+json.dumps(result['error']))
    return result['result']

def encode(signature,*arguments):
    return subprocess.check_output(['cast','calldata',signature,*map(str,arguments)],text=True).strip()

def call(network,address,signature,*arguments):
    return rpc(network,'eth_call',[{'from':NETWORKS[network]['operator'],'to':address,
        'data':encode(signature,*arguments)},'latest'])

def creation(network):
    config=NETWORKS[network]
    artifact=json.loads((ROOT/config['artifact']).read_text())
    send_depth=BASE_CONFIRMATIONS if network=='base-sepolia' else 0
    receive_depth=BASE_CONFIRMATIONS if network=='hedera-testnet' else 0
    constructor='('+','.join(map(str,[config['operator'],config['router'],config['selector'],config['remoteSelector'],config['remoteChainId'],send_depth,receive_depth]))+')'
    signature='f((address,address,uint64,uint64,uint256,uint16,uint16),address'+(',address)' if network=='hedera-testnet' else ')')
    arguments=[constructor,TOKEN,ASSET] if network=='hedera-testnet' else [constructor,ASSET]
    encoded=subprocess.check_output(['cast','abi-encode',signature,*arguments],text=True).strip()
    return artifact['bytecode']['object']+encoded[2:]

def preflight(network):
    config=NETWORKS[network]
    assert int(rpc(network,'eth_chainId',[]),16)==config['chainId']
    router_code=rpc(network,'eth_getCode',[config['router'],'latest'])
    assert len(router_code)>20, 'No router bytecode'
    supported=int(call(network,config['router'],'isChainSupported(uint64)',config['remoteSelector']),16)
    assert supported==1, 'Router does not support the remote chain'
    balance=int(rpc(network,'eth_getBalance',[config['operator'],'latest']),16)
    nonce=int(rpc(network,'eth_getTransactionCount',[config['operator'],'pending']),16)
    data=creation(network)
    tx={'from':config['operator'],'data':data}
    estimated=int(rpc(network,'eth_estimateGas',[tx]),16)
    price=int(rpc(network,'eth_gasPrice',[]),16)
    decimals=int(call(network,TOKEN if network=='hedera-testnet' else ASSET,'decimals()'),16)
    assert decimals==6
    token_balance=int(call(network,TOKEN if network=='hedera-testnet' else ASSET,'balanceOf(address)',config['operator']),16)
    result={**config,'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'routerSupportsRemote':True,'gasBalanceWei':str(balance),'gasBalanceNative':str(balance/10**18),
        'nonce':nonce,'estimatedDeploymentGas':estimated,'gasPriceWei':str(price),
        'estimatedDeploymentCostNative':str(estimated*price/10**18),'creationBytes':(len(data)-2)//2,
        'artifactSha256':hashlib.sha256((ROOT/config['artifact']).read_bytes()).hexdigest(),
        'assetDecimals':decimals,'operatorTokenBalanceRaw':str(token_balance)}
    return network,result

if __name__=='__main__':
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        results=dict(pool.map(preflight,NETWORKS))
    print(json.dumps(results,indent=2))
