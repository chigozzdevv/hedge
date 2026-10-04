import concurrent.futures
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

spec=importlib.util.spec_from_file_location('hedge_deploy',Path(__file__).resolve().parent/'testnet-deploy.py')
deploy=importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)
chain=deploy.chain

def keccak(data):
    return subprocess.check_output(['cast','keccak',data],text=True).strip()

def verify(network):
    config=chain.NETWORKS[network]
    address=deploy.deployed(network)
    remote='base-sepolia' if network=='hedera-testnet' else 'hedera-testnet'
    artifact=json.loads((chain.ROOT/config['artifact']).read_text())
    observed=chain.rpc(network,'eth_getCode',[address,'latest'])
    actual=bytearray.fromhex(observed[2:])
    original=bytes(actual)
    expected=bytearray.fromhex(artifact['deployedBytecode']['object'][2:])
    assert len(actual)==len(expected), 'Deployed runtime size mismatch'
    # Compare every byte except the compiler-declared constructor immutable slots.
    # Their complete values are independently checked via the public getters below.
    for refs in artifact['deployedBytecode']['immutableReferences'].values():
        for ref in refs:
            start,end=ref['start'],ref['start']+ref['length']
            actual[start:end]=bytes(ref['length'])
            expected[start:end]=bytes(ref['length'])
    assert actual==expected, 'Deployed runtime differs from the compiled artifact'
    values={}
    immutable_values=set()
    for name in ['deployer','router','localSelector','remoteSelector','localChainId','remoteChainId','requestedFinalityConfig','allowedFinalityConfig','peer','instanceId']:
        encoded=chain.call(network,address,name+'()')
        if name not in ['peer','instanceId']:
            immutable_values.add(bytes.fromhex(encoded[2:]))
        values[name]=('0x'+encoded[-40:]) if name in ['deployer','router','peer'] else encoded if name=='instanceId' else encoded[:10] if name in ['requestedFinalityConfig','allowedFinalityConfig'] else int(encoded,16)
    assert values['deployer'].lower()==config['operator'].lower()
    assert values['router'].lower()==config['router'].lower()
    assert values['localSelector']==config['selector'] and values['remoteSelector']==config['remoteSelector']
    assert values['localChainId']==config['chainId'] and values['remoteChainId']==config['remoteChainId']
    if sys.argv[-1]=='configured':
        assert values['peer'].lower()==deploy.deployed(remote).lower()
        assert int(values['instanceId'],16)>0
    else:
        assert int(values['peer'],16)==0 and int(values['instanceId'],16)==0
    send_depth=chain.BASE_CONFIRMATIONS if network=='base-sepolia' else 0
    receive_depth=chain.BASE_CONFIRMATIONS if network=='hedera-testnet' else 0
    assert values['requestedFinalityConfig']=='0x'+format(send_depth,'08x')
    assert values['allowedFinalityConfig']=='0x'+format(receive_depth,'08x')
    if sys.argv[-1]=='configured':
        sender=subprocess.check_output(['cast','abi-encode','f(address)',values['peer']],text=True).strip()
        policy=chain.call(network,address,'getCCVsAndFinalityConfig(uint64,bytes)',config['remoteSelector'],sender)
        # ABI tuple: two empty default-CCV arrays, zero optional threshold, bytes4 policy.
        fields=[policy[i:i+64] for i in range(2,len(policy),64)]
        assert len(fields)==6 and int(fields[0],16)==128 and int(fields[1],16)==160
        assert int(fields[2],16)==0 and int(fields[4],16)==0 and int(fields[5],16)==0
        assert '0x'+fields[3][:8]==values['allowedFinalityConfig']
    asset_name='collateralAsset'
    values[asset_name]='0x'+chain.call(network,address,asset_name+'()')[-40:]
    immutable_values.add(bytes.fromhex(values[asset_name][2:].rjust(64,'0')))
    assert values[asset_name].lower()==chain.ASSET.lower()
    if network=='hedera-testnet':
        values['loanToken']='0x'+chain.call(network,address,'loanToken()')[-40:]
        immutable_values.add(bytes.fromhex(values['loanToken'][2:].rjust(64,'0')))
        assert values['loanToken'].lower()==chain.TOKEN.lower()
        for name in ['capital','reservedCapital','freeCapital']:
            values[name]=str(int(chain.call(network,address,name+'(address)',config['operator']),16))
        values['nativeTokenBalanceRaw']=str(int(chain.call(network,chain.TOKEN,'balanceOf(address)',address),16))
    assert int(chain.call(network,address,'protocolVersion()'),16)==3
    # Every occurrence of each compiler immutable must equal its verified getter.
    embedded=set()
    for refs in artifact['deployedBytecode']['immutableReferences'].values():
        occurrences={original[ref['start']:ref['start']+ref['length']] for ref in refs}
        assert len(occurrences)==1, 'Inconsistent embedded immutable'
        embedded.update(occurrences)
    assert embedded==immutable_values, 'Embedded immutables do not match verified getters'
    assert int(chain.call(network,config['router'],'isChainSupported(uint64)',config['remoteSelector']),16)==1
    return network,{'address':address,'runtimeCodeHash':keccak(observed),'runtimeBytes':len(expected),
        'compiledRuntimeMatched':True,'artifactSha256':hashlib.sha256((chain.ROOT/config['artifact']).read_bytes()).hexdigest(),
        'constructorConfigurationVerified':True,'values':values}

def native_contract(address):
    url='https://testnet.mirrornode.hedera.com/api/v1/contracts/'+address
    response=subprocess.check_output(['curl','-fsS','--max-time','30',url],text=True)
    record=json.loads(response)
    assert record['evm_address'].lower()==address.lower() and not record['deleted']
    number=int(record['contract_id'].split('.')[-1])
    encoded=[]
    value=number
    while value>127:
        encoded.append((value&127)|128)
        value>>=7
    encoded.append(value)
    inner=bytes([24,*encoded])
    # Ethereum creation externalizes an absent admin key as this self ContractID.
    # Reject cryptographic keys, key lists, delegate keys and other ContractIDs.
    expected=bytes([10,len(inner)])+inner
    assert record['admin_key']=={'_type':'ProtobufEncoded','key':expected.hex()}
    return {'contractId':record['contract_id'],'evmAddress':record['evm_address'],
        'adminKey':record['admin_key'],'selfContractKeyVerified':True,
        'externalAdminKeyPresent':False,'deleted':False,'source':url}

def write_manifest(results):
    native=native_contract(results['hedera-testnet']['address'])
    verified_at=datetime.datetime.now(datetime.timezone.utc).isoformat()
    build=hashlib.sha256(json.dumps({network:result['artifactSha256'] for network,result in results.items()},sort_keys=True).encode()).hexdigest()
    manifest={'schema_version':1,'instance_id':results['hedera-testnet']['values']['instanceId'],
        'build_id':'solc-0.8.24:sha256:'+build,'protocol_version':3,'deployer':results['hedera-testnet']['values']['deployer']}
    for network,name in [('hedera-testnet','hedera'),('base-sepolia','base')]:
        result=results[network]
        manifest[name]={'chain_id':result['values']['localChainId'],'router':result['values']['router'],
            'selector':str(result['values']['localSelector']),'contract':result['address'],
            'code_hash':result['runtimeCodeHash'],
            'ccip_policy':{'requested_finality':result['values']['requestedFinalityConfig'],
                'allowed_finality':result['values']['allowedFinalityConfig']}}
    manifest['hedera']['contract_id']=native['contractId']
    transactions={}
    for network,operations in [('hedera-testnet',['contract','peer','approve','capital']),('base-sepolia',['contract','peer'])]:
        transactions[network]={}
        for operation in operations:
            record=json.loads((chain.RUN_DIR/('deploy-'+network+'-'+operation+'.json')).read_text())
            receipt=chain.rpc(network,'eth_getTransactionReceipt',[record['transactionHash']])
            assert receipt and int(receipt['status'],16)==1
            assert record['status']=='confirmed_success' and record['receipt']['blockHash']==receipt['blockHash']
            transactions[network][operation]={'transactionHash':record['transactionHash'],'receipt':receipt}
    verification={'verified_at':verified_at}
    start={}
    for network,name in [('hedera-testnet','hedera'),('base-sepolia','base')]:
        transaction=transactions[network]['contract']
        receipt=transaction['receipt']
        start[name]=str(int(receipt['blockNumber'],16))
        verification[name]={'transaction_hash':transaction['transactionHash'],'receipt_status':int(receipt['status'],16),
            'block_number':start[name],'block_hash':receipt['blockHash'],'contract':receipt['contractAddress'],
            'code_hash':results[network]['runtimeCodeHash'],'instance_id':results[network]['values']['instanceId'],
            'compiled_runtime_matched':results[network]['compiledRuntimeMatched']}
    record={'schema_version':1,'deployment':manifest,'rpc':{'hedera':chain.NETWORKS['hedera-testnet']['rpc'],
        'base':chain.NETWORKS['base-sepolia']['rpc']},'start_block':start,
        'mirror_url':'https://testnet.mirrornode.hedera.com',
        'operator':chain.NETWORKS['hedera-testnet']['operator'],'operator_url':'http://127.0.0.1:3003/testnet','verification':verification}
    deploy.save(chain.RUN_DIR/'deployment.json',record)
    print('Verified deployment prepared for the manager; full receipts remain private.',flush=True)

if __name__=='__main__':
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        result=dict(pool.map(verify,chain.NETWORKS))
    if sys.argv[-1]=='configured':
        assert result['hedera-testnet']['values']['instanceId']==result['base-sepolia']['values']['instanceId']
        write_manifest(result)
    print(json.dumps(result,indent=2))
