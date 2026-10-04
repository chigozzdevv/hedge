import datetime
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent.parent

if not __debug__:
    raise RuntimeError('Run without Python optimization; safety assertions must remain enabled.')

def module(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    result=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

chain=module('hedge_deploy_chain',ROOT/'scripts/testnet-chain.py')
keys=module('hedge_deploy_keys',ROOT/'scripts/wallet-sign.py')
def rlp_item(data, position=0):
    first=data[position]
    if first<=0x7f:
        return bytes([first]),position+1
    if first<=0xb7:
        size=first-0x80
        return data[position+1:position+1+size],position+1+size
    if first<=0xbf:
        length_size=first-0xb7
        size=int.from_bytes(data[position+1:position+1+length_size],'big')
        start=position+1+length_size
        return data[start:start+size],start+size
    if first<=0xf7:
        size=first-0xc0
        start=position+1
    else:
        length_size=first-0xf7
        size=int.from_bytes(data[position+1:position+1+length_size],'big')
        start=position+1+length_size
    end=start+size
    values=[]
    while start<end:
        value,start=rlp_item(data,start)
        values.append(value)
    assert start==end
    return values,end




def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def save(path,record):
    path.write_text(json.dumps(record,indent=2)+'\n')

def confirm(path,record):
    for attempt in range(24):
        receipt=chain.rpc(record['network'],'eth_getTransactionReceipt',[record['transactionHash']])
        if receipt:
            record.update({'receipt':receipt,'checkedAt':now(),
                'status':'included_unconfirmed' if int(receipt['status'],16)==1 else 'confirmed_revert'})
            save(path,record)
            if int(receipt['status'],16)!=1:
                raise RuntimeError('Transaction reverted. Inspect saved evidence before any further action.')
            if record['network']=='base-sepolia':
                # Include several canonical blocks before treating deployment as stable.
                height=int(receipt['blockNumber'],16)
                for _ in range(15):
                    if int(chain.rpc(record['network'],'eth_blockNumber',[]),16)>=height+3:
                        refreshed=chain.rpc(record['network'],'eth_getTransactionReceipt',[record['transactionHash']])
                        if refreshed and refreshed['blockHash']==receipt['blockHash']:
                            break
                        if refreshed:
                            receipt=refreshed
                            height=int(receipt['blockNumber'],16)
                            record['receipt']=receipt
                    time.sleep(2)
                else:
                    raise RuntimeError('Additional Base block confirmations are pending; resume this saved transaction.')
            record.update({'status':'confirmed_success','checkedAt':now()})
            save(path,record)
            print(record['network']+' '+record['operation']+': '+record['status']+' '+record['transactionHash'],flush=True)
            return record
        time.sleep(2)
    record['status']='confirmation_pending'
    save(path,record)
    raise RuntimeError('Confirmation pending for saved hash '+record['transactionHash']+'. No replacement was submitted.')

def execute(network,operation,to,data,maximum_native_cost,*,signer_network=None,value=0,record_prefix='deploy',reserve_native=None,on_submitted=None):
    config=chain.NETWORKS[network]
    assert re.fullmatch('[a-z][a-z0-9-]{0,60}',operation)
    assert record_prefix in ['deploy','loan']
    assert isinstance(value,int) and value>=0
    wallet=keys.wallet_for(signer_network or network)
    sender=wallet['address']
    if signer_network is None:
        assert sender.lower()==config['operator'].lower()
    path=chain.RUN_DIR/(record_prefix+'-'+network+'-'+operation+'.json')
    if path.exists():
        record=json.loads(path.read_text())
        assert record['network']==network and record['operation']==operation
        assert record['sender'].lower()==sender.lower() and record['chainId']==config['chainId']
        assert record['transaction']['data'].lower()==data.lower(), 'Prepared data changed'
        assert record['transaction'].get('to')==to, 'Prepared recipient changed'
        assert int(record['transaction'].get('value','0x0'),16)==value, 'Prepared value changed'
        if record.get('transactionHash'):
            assert subprocess.check_output(['cast','keccak',record['signedTransaction']],text=True).strip()==record['transactionHash']
            print('Resuming saved '+operation+' transaction; no new transaction will be created.',flush=True)
            if on_submitted:
                on_submitted(record['transactionHash'])
            if not chain.rpc(network,'eth_getTransactionReceipt',[record['transactionHash']]) and not chain.rpc(network,'eth_getTransactionByHash',[record['transactionHash']]):
                # Crash recovery rebroadcasts only the exact saved signed bytes, with the same hash and nonce.
                try:
                    submitted=chain.rpc(network,'eth_sendRawTransaction',[record['signedTransaction']])
                    assert submitted.lower()==record['transactionHash'].lower()
                except Exception:
                    pass  # Confirm the original hash; never create a replacement on ambiguity.
            return confirm(path,record)
        raise RuntimeError('An unsigned preparation already exists; inspect it before proceeding.')
    assert int(chain.rpc(network,'eth_chainId',[]),16)==config['chainId']
    pending=int(chain.rpc(network,'eth_getTransactionCount',[sender,'pending']),16)
    latest=int(chain.rpc(network,'eth_getTransactionCount',[sender,'latest']),16)
    assert latest==pending, 'Outstanding wallet transaction'
    tx={'from':sender,'data':data,'value':hex(value)}
    if to:
        tx['to']=to
        chain.rpc(network,'eth_call',[tx,'latest'])
    estimate=int(chain.rpc(network,'eth_estimateGas',[tx]),16)
    gas_limit=(estimate*125+99)//100
    gas_price=int(chain.rpc(network,'eth_gasPrice',[]),16)
    maximum_cost=gas_limit*gas_price+value
    assert maximum_cost<=maximum_native_cost*10**18, 'Gas cost exceeds transaction budget'
    balance=int(chain.rpc(network,'eth_getBalance',[sender,'latest']),16)
    reserve=40*10**18 if network=='hedera-testnet' else 5*10**15
    if reserve_native is not None:
        assert reserve_native>=0
        reserve=int(reserve_native*10**18)
    assert balance-maximum_cost>=reserve, 'Gas reserve would be exhausted'
    record={'operation':operation,'network':network,'chainId':config['chainId'],'sender':sender,
        'createdAt':now(),'status':'prepared','transaction':tx,'nonce':pending,'estimatedGas':estimate,
        'gasLimit':gas_limit,'gasPriceWei':str(gas_price),'maximumGasCostWei':str(gas_limit*gas_price),
        'transactionValueWei':str(value),'maximumTotalCostWei':str(maximum_cost)}
    private_key=wallet['private_key']
    signer=keys.with_key(['wallet','address'],private_key)
    assert signer.lower()==sender.lower(), 'Wallet key differs from transaction sender'
    save(path,record)
    arguments=['mktx','--value',str(value),'--gas-limit',str(gas_limit),'--gas-price',str(gas_price),
        '--nonce',str(pending),'--chain',str(config['chainId']),'--legacy','--rpc-url',config['rpc']]
    arguments+=([to,data] if to else ['--create',data])
    raw=keys.with_key(arguments,private_key)
    private_key=None
    binary=bytes.fromhex(raw[2:])
    fields,end=rlp_item(binary)
    number=lambda v:int.from_bytes(v,'big')
    assert end==len(binary) and len(fields)==9
    assert [number(fields[i]) for i in range(3)]==[pending,gas_price,gas_limit]
    assert fields[3].hex()==(to[2:].lower() if to else '')
    assert number(fields[4])==value and '0x'+fields[5].hex()==data.lower()
    assert (number(fields[6])-35)//2==config['chainId']
    transaction_hash=subprocess.check_output(['cast','keccak',raw],text=True).strip()
    assert re.fullmatch('0x[0-9a-fA-F]{64}',transaction_hash)
    record.update({'status':'signed_not_broadcast','transactionHash':transaction_hash,'signedTransaction':raw})
    save(path,record)
    if on_submitted:
        on_submitted(transaction_hash)
    record['status']='broadcasting'
    save(path,record)
    print(network+' '+operation+': submitting saved transaction '+transaction_hash,flush=True)
    try:
        result=chain.rpc(network,'eth_sendRawTransaction',[raw])
        assert result.lower()==transaction_hash.lower(), 'Unexpected returned hash'
        record.update({'status':'submitted','submittedAt':now()})
    except Exception as error:
        record.update({'status':'broadcast_result_unknown','relayDiagnostic':str(error)[:700]})
        print('Relay result uncertain; checking the original saved hash.',flush=True)
    save(path,record)
    return confirm(path,record)

def deployed(network):
    record=json.loads((chain.RUN_DIR/('deploy-'+network+'-contract.json')).read_text())
    assert record['status']=='confirmed_success'
    assert record['chainId']==chain.NETWORKS[network]['chainId']
    assert record['sender'].lower()==chain.NETWORKS[network]['operator'].lower()
    address=record['receipt']['contractAddress']
    assert re.fullmatch('0x[0-9a-fA-F]{40}',address) and int(address,16)>0
    return address

def main():
    network,operation=sys.argv[1:3]
    assert network in chain.NETWORKS
    if operation=='contract':
        result=execute(network,operation,None,chain.creation(network),7 if network=='hedera-testnet' else 0.002)
        print('Contract address: '+result['receipt']['contractAddress'],flush=True)
    elif operation=='peer':
        remote='base-sepolia' if network=='hedera-testnet' else 'hedera-testnet'
        execute(network,operation,deployed(network),chain.encode('configurePeer(address)',deployed(remote)),2 if network=='hedera-testnet' else 0.001)
    elif operation=='approve':
        assert network=='hedera-testnet'
        execute(network,operation,chain.TOKEN,chain.encode('approve(address,uint256)',deployed(network),chain.CAPITAL_AMOUNT),1)
        assert int(chain.call(network,chain.TOKEN,'allowance(address,address)',chain.NETWORKS[network]['operator'],deployed(network)),16)==chain.CAPITAL_AMOUNT
    elif operation=='capital':
        assert network=='hedera-testnet'
        execute(network,operation,deployed(network),chain.encode('deposit(uint256)',chain.CAPITAL_AMOUNT),2)
        assert int(chain.call(network,deployed(network),'capital(address)',chain.NETWORKS[network]['operator']),16)==chain.CAPITAL_AMOUNT
        assert int(chain.call(network,chain.TOKEN,'balanceOf(address)',deployed(network)),16)==chain.CAPITAL_AMOUNT
        print(str(chain.CAPITAL_AMOUNT/10**6)+' test USDC capital and native token balance verified.',flush=True)
    else:
        raise RuntimeError('Unknown deployment operation')

if __name__=='__main__':
    os.umask(0o077)
    try:
        main()
    except Exception as error:
        diagnostic=str(error)
        for password in keys.SECRET_VALUES:
            diagnostic=diagnostic.replace(password,'[redacted]')
        print(type(error).__name__+': '+diagnostic[:1800],file=sys.stderr)
        sys.exit(1)
