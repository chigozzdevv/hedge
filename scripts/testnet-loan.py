"""A resumable, small real-chain loan test. No mocked transport or UI funding."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time

spec=importlib.util.spec_from_file_location('hedge_deploy',Path(__file__).resolve().parent/'testnet-deploy.py')
deploy=importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)
chain=deploy.chain
ROOT=deploy.ROOT
STATE=chain.RUN_DIR/'loan-test.json'
LENDING=deploy.deployed('hedera-testnet')
VAULT=deploy.deployed('base-sepolia')
BORROWER=chain.NETWORKS['base-sepolia']['operator']
OPERATOR=chain.NETWORKS['hedera-testnet']['operator']
SAUCER='0x0000000000000000000000000000000000004b40'
WHBAR='0x0000000000000000000000000000000000003ad2'
WHBAR_CONTRACT='0x0000000000000000000000000000000000003ad1'
TERMS='(address,address,uint256,uint256,address,uint256,address,address,address,uint64,uint64,uint32,uint32,bytes32,uint256)'
GAS=1000000

def hash_encoded(signature,*args):
    encoded=subprocess.check_output(['cast','abi-encode',signature,*map(str,args)],text=True).strip()
    return subprocess.check_output(['cast','keccak',encoded],text=True).strip()

def hash_text(text):
    return subprocess.check_output(['cast','keccak',text],text=True).strip()

def call(network,to,signature,*args,sender=None,value=0):
    tx={'from':sender or chain.NETWORKS[network]['operator'],'to':to,
        'data':chain.encode(signature,*args),'value':hex(value)}
    return chain.rpc(network,'eth_call',[tx,'latest'])

def words(encoded):
    assert encoded.startswith('0x') and (len(encoded)-2)%64==0
    return ['0x'+encoded[i:i+64] for i in range(2,len(encoded),64)]

def token_balance(network,address):
    return int(call(network,chain.TOKEN if network=='hedera-testnet' else chain.ASSET,
        'balanceOf(address)',address),16)

def state():
    result=json.loads(STATE.read_text())
    assert result['borrower'].lower()==BORROWER.lower()
    assert result['lending'].lower()==LENDING.lower() and result['vault'].lower()==VAULT.lower()
    assert result['instanceId']==call('hedera-testnet',LENDING,'instanceId()')
    assert result['instanceId']==call('base-sepolia',VAULT,'instanceId()')
    return result

def execute(network,operation,to,data,budget,*,borrower=False,value=0):
    return deploy.execute(network,operation,to,data,budget,signer_network='base-sepolia' if borrower else None,
        value=value,record_prefix='loan',reserve_native=0.25 if borrower and network=='hedera-testnet' else None)

def loan(result):
    values=words(call('hedera-testnet',LENDING,'getLoan(bytes32)',result['loanId']))
    assert len(values)==31 and int(values[0],16)==3 and values[1]==result['instanceId'] and values[11]==result['loanId']
    assert '0x'+values[12][-40:]==BORROWER.lower()
    return {'agreementHash':values[27],'state':int(values[28],16),
        'fundedAt':int(values[29],16),'paymentDeadline':int(values[30],16)}

def custody(result):
    values=words(call('base-sepolia',VAULT,'getCustody(bytes32)',result['loanId']))
    assert len(values)==32
    return {'agreementHash':values[27],'authorized':bool(int(values[28],16)),
        'locked':bool(int(values[29],16)),'claimed':bool(int(values[30],16)),
        'outcome':int(values[31],16)}

def prepare():
    if STATE.exists():
        print('Reusing saved loan identities and terms; no new loan will be created.',flush=True)
        print(json.dumps(state(),indent=2))
        return
    assert token_balance('base-sepolia',BORROWER)>=2*10**6, 'Base collateral needs 2 test USDC'
    assert int(call('hedera-testnet',LENDING,'freeCapital(address)',OPERATOR),16)>=10**6
    instance=call('hedera-testnet',LENDING,'instanceId()')
    nonce=int(call('hedera-testnet',LENDING,'offerNonce(address)',OPERATOR),16)+1
    timestamp=int(chain.rpc('hedera-testnet','eth_getBlockByNumber',['latest',False])['timestamp'],16)
    offer_id=hash_encoded('f(bytes32,address,uint256)',instance,OPERATOR,nonce)
    loan_id=hash_encoded('f(string,bytes32,bytes32)','hedge-loan-v3',instance,offer_id)
    terms=[BORROWER,BORROWER,10**6,1020000,chain.ASSET,2*10**6,BORROWER,BORROWER,OPERATOR,
        timestamp+7200,timestamp+86400,30*86400,0,hash_text('Hedge '+(chain.RUN_NAME or 'finalized')+' testnet: Base custody depth '+str(chain.BASE_CONFIRMATIONS)+'; 1 USDC; repay 1.02 USDC; 2 Base USDC; 30 days; fixed charge; network fees separate.'),1020000]
    initial={'baseCollateralRaw':str(token_balance('base-sepolia',BORROWER)),
        'borrowerLoanTokenRaw':str(token_balance('hedera-testnet',BORROWER)),
        'operatorLoanTokenRaw':str(token_balance('hedera-testnet',OPERATOR)),
        'capitalRaw':str(int(call('hedera-testnet',LENDING,'capital(address)',OPERATOR),16)),
        'reservedCapitalRaw':str(int(call('hedera-testnet',LENDING,'reservedCapital(address)',OPERATOR),16))}
    assert initial['reservedCapitalRaw']=='0'
    result={'createdAt':deploy.now(),'instanceId':instance,'lending':LENDING,'vault':VAULT,
        'borrower':BORROWER,'operator':OPERATOR,'offerId':offer_id,'loanId':loan_id,
        'terms':terms,'initial':initial,'completed':False}
    deploy.save(STATE,result)
    print(json.dumps(result,indent=2))

def fund_gas():
    result=execute('hedera-testnet','borrower-gas',BORROWER,'0x',5,value=4*10**18)
    assert int(chain.rpc('hedera-testnet','eth_getBalance',[BORROWER,'latest']),16)>=4*10**18
    return result

def fund_fees():
    assert loan(state())['state']==2
    return execute('hedera-testnet','borrower-fees',BORROWER,'0x',3,value=2*10**18)

def associate():
    if int(call('hedera-testnet',chain.TOKEN,'isAssociated()',sender=BORROWER),16)==1:
        print('Existing native token association verified; no redundant association transaction is needed.',flush=True)
        return
    execute('hedera-testnet','borrower-association',chain.TOKEN,chain.encode('associate()'),1.5,borrower=True)
    assert int(call('hedera-testnet',chain.TOKEN,'isAssociated()',sender=BORROWER),16)==1

def buffer():
    result=state()
    execute('hedera-testnet','repayment-buffer',chain.TOKEN,chain.encode('transfer(address,uint256)',BORROWER,120000),0.5)
    expected=int(result['initial']['borrowerLoanTokenRaw'])+120000
    assert token_balance('hedera-testnet',BORROWER)==expected, 'Borrower buffer balance mismatch'

def publish():
    result=state()
    term='('+','.join(map(str,result['terms']))+')'
    execute('hedera-testnet','publish',LENDING,chain.encode('publishOffer('+TERMS+')',term),2)
    offer=words(call('hedera-testnet',LENDING,'getOffer(bytes32)',result['offerId']))
    assert len(offer)==18 and int(offer[17],16)==1
    assert ('0x'+offer[0][-40:]).lower()==OPERATOR.lower()
    expected=subprocess.check_output(['cast','abi-encode','f('+TERMS+')',term],text=True).strip()
    assert '0x'+''.join(word[2:] for word in offer[1:16])==expected
    result['termsHash']=offer[16]
    deploy.save(STATE,result)
    assert int(call('hedera-testnet',LENDING,'reservedCapital(address)',OPERATOR),16)==10**6
    print('Funded offer reserved exactly 1 test USDC.',flush=True)

def accept():
    result=state()
    execute('hedera-testnet','accept',LENDING,chain.encode('accept(bytes32,bytes32)',result['offerId'],result['termsHash']),2,borrower=True)
    observed=loan(result)
    assert observed['state']==1 and observed['fundedAt']==0
    result['agreementHash']=observed['agreementHash']
    deploy.save(STATE,result)
    print('Loan accepted; payout is still unconfirmed.',flush=True)

def send(kind):
    result=state()
    if kind==1:
        locked=json.loads((chain.RUN_DIR/'loan-base-sepolia-collateral-lock.json').read_text())
        assert locked['status']=='confirmed_success' and custody(result)['locked'], 'Collateral lock must be confirmed first'
    elif kind==3:
        assert custody(result)['claimed'] and custody(result)['outcome']==3
    elif kind==2:
        assert loan(result)['state'] in [3,4,5,6], 'No canonical outcome has been decided'
    network='base-sepolia' if kind in [1,3] else 'hedera-testnet'
    contract=VAULT if kind in [1,3] else LENDING
    operation=call(network,contract,'operationId(bytes32,uint8)',result['loanId'],kind)
    name=['agreement','custody','outcome','settlement'][kind]
    previous=chain.RUN_DIR/('loan-'+network+'-'+name+'-message.json')
    if previous.exists():
        saved=json.loads(previous.read_text())
        value=int(saved['transaction']['value'],16)
        quote=value//10**10 if network=='hedera-testnet' else value
        print('Checking the existing '+name+' message submission.',flush=True)
    else:
        quote=int(call(network,contract,'quoteMessage(bytes32,uint256)',operation,GAS),16)
        value=quote*10**10 if network=='hedera-testnet' else quote
        print(name+' message fresh fee: '+str(value/10**18)+' '+('HBAR' if network=='hedera-testnet' else 'ETH')+'.',flush=True)
    assert value<=12*10**18 if network=='hedera-testnet' else value<=10**15, 'CCIP fee exceeds test budget'
    record=execute(network,name+'-message',contract,chain.encode('sendMessage(bytes32,uint256)',operation,GAS),
        13 if network=='hedera-testnet' else 0.002,value=value)
    topic=hash_text('MessageSubmitted(bytes32,bytes32,uint256)')
    events=[event for event in record['receipt']['logs'] if event['address'].lower()==contract.lower()
        and event['topics'][0]==topic and event['topics'][1]==operation]
    assert len(events)==1
    result.setdefault('messages',{})[name]={'messageId':events[0]['topics'][2],
        'sourceTransactionHash':record['transactionHash'],'destinationGasLimit':GAS,
        'feeRaw':str(quote),'transactionValueWei':str(value),'operationId':operation}
    deploy.save(STATE,result)
    print('Submitted to real CCIP: '+events[0]['topics'][2]+'. Destination execution is pending.',flush=True)

def poll():
    result=state()
    statuses={}
    for name,message in result.get('messages',{}).items():
        network='hedera-testnet' if name in ['custody','settlement'] else 'base-sepolia'
        target=LENDING if name in ['custody','settlement'] else VAULT
        received=call(network,target,'receivedMessages(bytes32)',message['messageId'])
        statuses[name]={'messageId':message['messageId'],'received':int(received,16)!=0}
    observed={'checkedAt':deploy.now(),'messages':statuses,'loan':loan(result),'custody':custody(result),
        'borrowerUSDC':str(token_balance('hedera-testnet',BORROWER)),
        'baseCollateralUSDC':str(token_balance('base-sepolia',BORROWER)),
        'vaultTokenBalanceRaw':str(token_balance('base-sepolia',VAULT)),
        'capitalRaw':str(int(call('hedera-testnet',LENDING,'capital(address)',OPERATOR),16)),
        'reservedCapitalRaw':str(int(call('hedera-testnet',LENDING,'reservedCapital(address)',OPERATOR),16))}
    result['lastObservation']=observed
    deploy.save(STATE,result)
    print(json.dumps(observed,indent=2))

def await_delivery(name):
    result=state()
    message=result['messages'][name]
    url='https://api.ccip.chain.link/v2/messages/'+message['messageId']
    expected_depth=chain.BASE_CONFIRMATIONS if name in ['custody','settlement'] else 0
    expected_sender=VAULT if name in ['custody','settlement'] else LENDING
    expected_receiver=LENDING if name in ['custody','settlement'] else VAULT
    end=time.monotonic()+600
    while time.monotonic()<end:
        response=subprocess.run(['curl','-fsS','--max-time','25',url],text=True,capture_output=True,timeout=30)
        if response.returncode==0:
            observed=json.loads(response.stdout)
            assert observed['messageId'].lower()==message['messageId'].lower()
            assert observed['sender'].lower()==expected_sender.lower() and observed['receiver'].lower()==expected_receiver.lower()
            assert observed['sendTransactionHash'].lower()==message['sourceTransactionHash'].lower()
            assert int(observed['extraArgs']['requestedFinalityConfig'],16)==expected_depth
            if observed['status']=='SUCCESS':
                delivery(name,observed['receiptTransactionHash'])
                result=state()
                result['messages'][name]['ccipObservation']=observed
                deploy.save(STATE,result)
                print(name+' actual CCIP delivery: '+str(observed['deliveryTime']/1000)+' seconds; requested depth '+str(expected_depth)+'.',flush=True)
                return
            print(name+' delivery pending: '+str(observed['status'])+'; no payout/claim inferred.',flush=True)
        else:
            print(name+' indexer observation pending; saved message remains resumable.',flush=True)
        time.sleep(10)
    raise RuntimeError('Delivery pending after bounded wait. Resume this saved message with await-delivery; no new message was submitted.')

def delivery(name,transaction_hash):
    result=state()
    message=result['messages'][name]
    network='hedera-testnet' if name in ['custody','settlement'] else 'base-sepolia'
    target=LENDING if name in ['custody','settlement'] else VAULT
    receipt=chain.rpc(network,'eth_getTransactionReceipt',[transaction_hash])
    assert receipt and int(receipt['status'],16)==1, 'Destination transaction is not successful'
    event_topic=hash_text('MessageReceived(bytes32,bytes32,uint8)')
    matches=[event for event in receipt['logs'] if event['address'].lower()==target.lower()
        and event['topics'][0]==event_topic and event['topics'][1]==message['messageId']
        and event['topics'][2]==result['loanId']]
    assert len(matches)==1, 'Receipt does not prove this exact CCIP message was received'
    assert int(call(network,target,'receivedMessages(bytes32)',message['messageId']),16)>0
    message['destinationTransactionHash']=transaction_hash
    message['destinationReceipt']=receipt
    source_network='base-sepolia' if name in ['custody','settlement'] else 'hedera-testnet'
    source=chain.rpc(source_network,'eth_getTransactionReceipt',[message['sourceTransactionHash']])
    assert source and int(source['status'],16)==1
    source_block=chain.rpc(source_network,'eth_getBlockByNumber',[source['blockNumber'],False])
    destination_block=chain.rpc(network,'eth_getBlockByNumber',[receipt['blockNumber'],False])
    message['sourceTimestamp']=int(source_block['timestamp'],16)
    message['destinationTimestamp']=int(destination_block['timestamp'],16)
    message['deliverySeconds']=message['destinationTimestamp']-message['sourceTimestamp']
    message['explorerUrl']='https://ccip.chain.link/msg/'+message['messageId']
    message['deliveryVerifiedAt']=deploy.now()
    deploy.save(STATE,result)
    print(name+' exact destination receipt and receiver marker verified.',flush=True)

def lock():
    result=state()
    entry=custody(result)
    assert entry['authorized'] and not entry['locked'] and entry['agreementHash']==result['agreementHash']
    execute('base-sepolia','collateral-approval',chain.ASSET,chain.encode('approve(address,uint256)',VAULT,2*10**6),0.001)
    execute('base-sepolia','collateral-lock',VAULT,chain.encode('lock(bytes32,bytes32)',result['loanId'],result['agreementHash']),0.001)
    entry=custody(result)
    assert entry['locked'] and not entry['claimed'] and entry['outcome']==0
    assert token_balance('base-sepolia',BORROWER)==int(result['initial']['baseCollateralRaw'])-2*10**6
    assert token_balance('base-sepolia',VAULT)==2*10**6
    print('Exactly 2 Base test USDC locked; Hedera funding requires CCIP custody delivery.',flush=True)

def funding():
    result=state()
    observed=loan(result)
    assert observed['state']==2 and observed['fundedAt']>0
    assert observed['paymentDeadline']==observed['fundedAt']+result['terms'][11]+result['terms'][12]
    balance=token_balance('hedera-testnet',BORROWER)
    assert balance==int(result['initial']['borrowerLoanTokenRaw'])+1120000
    capital=int(call('hedera-testnet',LENDING,'capital(address)',OPERATOR),16)
    assert capital==int(result['initial']['capitalRaw'])-result['terms'][2]
    assert int(call('hedera-testnet',LENDING,'reservedCapital(address)',OPERATOR),16)==0
    assert result['messages']['custody'].get('destinationReceipt'), 'Verify the exact custody receipt first'
    receipt=result['messages']['custody']['destinationReceipt']
    topic=hash_text('LoanFunded(bytes32,address,uint256,uint256)')
    events=[event for event in receipt['logs'] if event['address'].lower()==LENDING.lower()
        and event['topics'][0]==topic and event['topics'][1]==result['loanId']]
    assert len(events)==1
    values=words(events[0]['data'])
    assert '0x'+values[0][-40:]==BORROWER.lower() and int(values[1],16)==result['terms'][2]
    assert int(values[2],16)==observed['paymentDeadline']
    result['fundingObservation']={'checkedAt':deploy.now(),**observed,
        'borrowerLoanTokenRaw':str(balance),'capitalRaw':str(capital),'reservedCapitalRaw':'0',
        'fundingEvent':events[0]}
    if chain.BASE_CONFIRMATIONS:
        source=chain.rpc('base-sepolia','eth_getTransactionReceipt',[result['messages']['custody']['sourceTransactionHash']])
        assert source and int(source['status'],16)==1
        canonical=chain.rpc('base-sepolia','eth_getBlockByNumber',[source['blockNumber'],False])
        assert canonical['hash']==source['blockHash']
        finalized=chain.rpc('base-sepolia','eth_getBlockByNumber',['finalized',False])
        result['fundingObservation']['baseFinalityCheck']={'checkedAt':deploy.now(),
            'sourceBlockNumber':int(source['blockNumber'],16),'sourceBlockHash':source['blockHash'],
            'finalizedBlockNumber':int(finalized['number'],16),
            'payoutPrecededSourceFinality':int(finalized['number'],16)<int(source['blockNumber'],16)}
    deploy.save(STATE,result)
    print('Real HTS payout verified: borrower received exactly 1 test USDC; term starts at confirmed funding.',flush=True)

def swap():
    result=state()
    assert loan(result)['state']==2 and loan(result)['fundedAt']>0, 'Loan is not confirmed funded'
    assert '0x'+call('hedera-testnet',WHBAR_CONTRACT,'token()')[-40:]==WHBAR
    existing=chain.RUN_DIR/'loan-hedera-testnet-swap.json'
    if existing.exists():
        saved=json.loads(existing.read_text())
        record=execute('hedera-testnet','swap',SAUCER,saved['transaction']['data'],1,borrower=True)
    else:
        assert token_balance('hedera-testnet',BORROWER)==int(result['initial']['borrowerLoanTokenRaw'])+1120000
        execute('hedera-testnet','swap-approval',chain.TOKEN,chain.encode('approve(address,uint256)',SAUCER,100000),1.5,borrower=True)
        path='['+chain.TOKEN+','+WHBAR+']'
        amounts=words(call('hedera-testnet',SAUCER,'getAmountsOut(uint256,address[])',100000,path,sender=BORROWER))
        assert int(amounts[0],16)==32 and int(amounts[1],16)==2 and int(amounts[2],16)==100000
        minimum=int(amounts[3],16)*99//100
        timestamp=int(chain.rpc('hedera-testnet','eth_getBlockByNumber',['latest',False])['timestamp'],16)
        data=chain.encode('swapExactTokensForETH(uint256,uint256,address[],address,uint256)',100000,minimum,path,BORROWER,timestamp+600)
        result['swap']={'inputTokenRaw':'100000','minimumOutputTinybar':str(minimum),'quotedOutputTinybar':str(int(amounts[3],16))}
        result['swap']['borrowerNativeBalanceBeforeWei']=str(int(chain.rpc('hedera-testnet','eth_getBalance',[BORROWER,'latest']),16))
        deploy.save(STATE,result)
        record=execute('hedera-testnet','swap',SAUCER,data,1,borrower=True)
    assert token_balance('hedera-testnet',BORROWER)==int(result['initial']['borrowerLoanTokenRaw'])+1020000
    result=state()
    result['swap']['transactionHash']=record['transactionHash']
    topic=hash_text('Withdrawal(address,address,uint256)')
    events=[event for event in record['receipt']['logs'] if event['address'].lower()==WHBAR_CONTRACT.lower()
        and event['topics'][0]==topic and '0x'+event['topics'][1][-40:]==SAUCER.lower()
        and '0x'+event['topics'][2][-40:] in [SAUCER.lower(),BORROWER.lower()]]
    assert len(events)==1, 'Expected exact SaucerSwap WHBAR withdrawal receipt'
    output=int(events[0]['data'],16)
    assert output>=int(result['swap']['minimumOutputTinybar'])
    native_after=int(chain.rpc('hedera-testnet','eth_getBalance',[BORROWER,'latest']),16)
    assert native_after>=int(result['swap']['borrowerNativeBalanceBeforeWei'])+output*10**10-int(record['maximumGasCostWei'])
    result['swap'].update({'actualOutputTinybar':str(output),'withdrawalEvent':events[0],
        'borrowerNativeBalanceAfterWei':str(native_after),'remainingLoanTokenRaw':str(token_balance('hedera-testnet',BORROWER))})
    deploy.save(STATE,result)
    print('Separate wallet swap confirmed; 1.02 test USDC remains for repayment.',flush=True)

def repay():
    result=state()
    assert loan(result)['state']==2
    execute('hedera-testnet','repay-approval',chain.TOKEN,chain.encode('approve(address,uint256)',LENDING,1020000),1.5,borrower=True)
    execute('hedera-testnet','repay',LENDING,chain.encode('repay(bytes32,uint256)',result['loanId'],1020000),1,borrower=True)
    assert loan(result)['state']==3
    assert token_balance('hedera-testnet',BORROWER)==int(result['initial']['borrowerLoanTokenRaw'])
    assert int(call('hedera-testnet',LENDING,'capital(address)',OPERATOR),16)==int(result['initial']['capitalRaw'])+20000
    print('Full repayment confirmed on Hedera; Base return authorization still requires CCIP.',flush=True)

def claim():
    result=state()
    assert loan(result)['state']==3
    entry=custody(result)
    assert entry['outcome']==1 and entry['locked'] and not entry['claimed']
    execute('base-sepolia','claim',VAULT,chain.encode('claim(bytes32)',result['loanId']),0.001)
    assert custody(result)['claimed']
    assert token_balance('base-sepolia',BORROWER)==int(result['initial']['baseCollateralRaw'])
    assert token_balance('base-sepolia',VAULT)==0
    assert int(call('base-sepolia',VAULT,'totalLocked()'),16)==0
    assert int(call('hedera-testnet',LENDING,'reservedCapital(address)',OPERATOR),16)==0
    result['completed']=True
    result['completedAt']=deploy.now()
    deploy.save(STATE,result)
    poll()
    print('Actual loan, app swap, full repayment and collateral return verified.',flush=True)

def guards(stage):
    result=state()
    if stage=='open':
        assert loan(result)['state']==2 and custody(result)['locked'] and not custody(result)['claimed']
        checks=[
            ('early-claim','base-sepolia',VAULT,'claim(bytes32)',[result['loanId']],BORROWER,'InvalidState()'),
            ('lock-again','base-sepolia',VAULT,'lock(bytes32,bytes32)',[result['loanId'],result['agreementHash']],BORROWER,'InvalidState()'),
            ('accept-again','hedera-testnet',LENDING,'accept(bytes32,bytes32)',[result['offerId'],result['termsHash']],BORROWER,'InvalidState()'),
            ('cancel-funded','hedera-testnet',LENDING,'cancel(bytes32)',[result['loanId']],BORROWER,'InvalidState()'),
            ('early-default','hedera-testnet',LENDING,'authorizeDefault(bytes32)',[result['loanId']],OPERATOR,'DeadlineNotPassed()'),
            ('wrong-repayment-signer','hedera-testnet',LENDING,'repay(bytes32,uint256)',[result['loanId'],1020000],OPERATOR,'Unauthorized()'),
            ('partial-repayment','hedera-testnet',LENDING,'repay(bytes32,uint256)',[result['loanId'],1019999],BORROWER,'IncorrectRepayment()'),
        ]
    else:
        assert stage=='done' and loan(result)['state']==3 and custody(result)['claimed']
        checks=[
            ('repeat-claim','base-sepolia',VAULT,'claim(bytes32)',[result['loanId']],BORROWER,'InvalidState()'),
            ('repeat-repayment','hedera-testnet',LENDING,'repay(bytes32,uint256)',[result['loanId'],1020000],BORROWER,'InvalidState()'),
        ]
    verified={}
    for name,network,target,signature,arguments,sender,error_signature in checks:
        selector=subprocess.check_output(['cast','sig',error_signature],text=True).strip()
        try:
            call(network,target,signature,*arguments,sender=sender)
        except RuntimeError as error:
            rpc_error=json.loads(str(error).split(': ',1)[1])
            revert_data=rpc_error.get('data','')
            assert isinstance(revert_data,str) and revert_data.lower().startswith(selector.lower()), name+' returned the wrong error'
            verified[name]={'checkedAt':deploy.now(),'method':signature,'expectedError':error_signature,
                'revertData':revert_data,'verification':'eth_call simulation against deployed contract; no transaction submitted'}
        else:
            raise RuntimeError(name+' unexpectedly succeeded')
    result.setdefault('guardChecks',{}).update(verified)
    deploy.save(STATE,result)
    print(json.dumps({'deployedContractGuardsVerified':list(verified),'verification':'read-only simulations; zero token or gas spending'},indent=2))

def evidence():
    poll()
    result=state()
    assert result['completed'] and result.get('fundingObservation') and result['swap'].get('actualOutputTinybar')
    assert loan(result)['state']==3 and custody(result)['claimed']
    assert result['lastObservation']['capitalRaw']==str(int(result['initial']['capitalRaw'])+20000)
    assert len(result.get('guardChecks',{}))==9
    for name in ['agreement','custody','outcome']:
        assert result['messages'][name].get('destinationReceipt') and result['lastObservation']['messages'][name]['received']
    allowed=['network','chainId','operation','sender','status','transactionHash','transaction','nonce',
        'gasLimit','gasPriceWei','transactionValueWei','maximumGasCostWei','maximumTotalCostWei',
        'submittedAt','checkedAt','receipt']
    transactions={}
    for path in sorted(chain.RUN_DIR.glob('loan-*.json')):
        if path==STATE:
            continue
        record=json.loads(path.read_text())
        assert record['status']=='confirmed_success'
        transactions[record['network']+':'+record['operation']]={key:record[key] for key in allowed if key in record}
    public={'schemaVersion':1,'scope':'Real testnet happy-path loan, separate wallet swap, repayment and collateral return',
        'testAssetsOnly':True,'verifiedAt':deploy.now(),'loanLifecycleVerified':True,
        'liveFrontendIntegrated':False,'liveDefaultCancellationRecoveryVerified':False,
        'deploymentManifest':'deployments/testnet.json','loan':result,'transactions':transactions,
        'tokens':{'loan':{'network':'hedera-testnet','tokenId':'0.0.5449','address':chain.TOKEN,'decimals':6},
            'collateral':{'network':'base-sepolia','address':chain.ASSET,'decimals':6}},
        'dex':{'network':'hedera-testnet','router':SAUCER,'wrappedHbarToken':WHBAR,'wrappedHbarContract':WHBAR_CONTRACT},
        'externalRepaymentBufferRaw':'120000'}
    if chain.RUN_NAME=='fast':
        timestamps={}
        for key in ['hedera-testnet:accept','base-sepolia:collateral-lock','hedera-testnet:repay','base-sepolia:claim']:
            transaction=transactions[key]
            block=chain.rpc(transaction['network'],'eth_getBlockByNumber',[transaction['receipt']['blockNumber'],False])
            timestamps[key]=int(block['timestamp'],16)
        payout=result['fundingObservation']['fundedAt']
        public['timingsSeconds']={'ccipAgreement':result['messages']['agreement']['deliverySeconds'],
            'ccipCustody':result['messages']['custody']['deliverySeconds'],
            'ccipOutcome':result['messages']['outcome']['deliverySeconds'],
            'acceptToPayout':payout-timestamps['hedera-testnet:accept'],
            'baseLockToPayout':payout-timestamps['base-sepolia:collateral-lock'],
            'repaymentToCollateralClaim':timestamps['base-sepolia:claim']-timestamps['hedera-testnet:repay'],
            'acceptToCollateralClaim':timestamps['base-sepolia:claim']-timestamps['hedera-testnet:accept']}
        public['confirmationPolicy']={'baseCustodyConfirmations':chain.BASE_CONFIRMATIONS,
            'hederaMessagesRequireFullFinality':True,'immutable':True,'defaultVerifiers':True,
            'operatorBearsSourceReorgShortfall':True,'productionRiskPolicyReviewed':False}
    directory=Path(tempfile.gettempdir())/'hedge-tests'/result['instanceId']
    directory.mkdir(parents=True,exist_ok=True,mode=0o700)
    path=directory/'loan.json'
    deploy.save(path,public)
    print('Public lifecycle evidence saved: '+str(path),flush=True)

if __name__=='__main__':
    try:
        action=sys.argv[1]
        functions={'prepare':prepare,'fund-gas':fund_gas,'fund-fees':fund_fees,'associate':associate,'buffer':buffer,
            'publish':publish,'accept':accept,'poll':poll,'lock':lock,'funding':funding,'swap':swap,'repay':repay,'claim':claim,'evidence':evidence}
        if action=='await-delivery':
            await_delivery(sys.argv[2])
        elif action=='delivery':
            delivery(*sys.argv[2:4])
        elif action.startswith('guards-'):
            guards(action[7:])
        elif action.startswith('send-'):
            send({'send-agreement':0,'send-custody':1,'send-outcome':2,'send-settlement':3}[action])
        else:
            functions[action]()
    except Exception as error:
        diagnostic=str(error)
        for secret in deploy.keys.SECRET_VALUES:
            diagnostic=diagnostic.replace(secret,'[redacted]')
        print(type(error).__name__+': '+diagnostic[:1800],file=sys.stderr)
        sys.exit(1)
