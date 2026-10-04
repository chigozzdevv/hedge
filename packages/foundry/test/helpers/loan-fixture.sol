// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestVm} from "./test-vm.sol";
import {MockToken} from "./mock-token.sol";
import {MockHts} from "./mock-hts.sol";
import {MockRouter} from "./mock-router.sol";
import {HedgeLending} from "../../src/hedera/hedge-lending.sol";
import {HedgeVault} from "../../src/base/hedge-vault.sol";
import {HedgeTypes} from "../../src/shared/hedge-types.sol";
import {CcipEndpoint} from "../../src/shared/ccip-endpoint.sol";
import {Client} from "../../vendor/ccip-2.0.0/libraries/Client.sol";

abstract contract LoanFixture {
    TestVm internal constant vm = TestVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address internal constant OPERATOR = address(0xa11ce);
    address internal constant BASE_OPERATOR = address(0xba5e);
    address internal constant BORROWER = address(0xb0b);
    address internal constant OWNER = address(0xc011);
    address internal constant RETURN = address(0x1234);
    address internal constant RECOVERY = address(0x5678);
    address internal constant STRANGER = address(0xdead);
    uint64 internal constant HEDERA_SELECTOR = 222782988166878823;
    uint64 internal constant BASE_SELECTOR = 10344971235874465080;
    MockToken internal token;
    MockToken internal asset;
    MockHts internal hts;
    MockRouter internal hederaRouter;
    MockRouter internal baseRouter;
    HedgeLending internal lending;
    HedgeVault internal vault;

    function setUp() public virtual {
        vm.warp(1800000000);
        vm.deal(address(this), 100 ether);
        token = new MockToken();
        asset = new MockToken();
        MockHts implementation = new MockHts();
        vm.etch(address(0x167), address(implementation).code);
        hts = MockHts(address(0x167));
        hederaRouter = new MockRouter();
        baseRouter = new MockRouter();
        vm.chainId(296);
        lending = new HedgeLending(
            CcipEndpoint.Config(
                OPERATOR, address(hederaRouter), HEDERA_SELECTOR, BASE_SELECTOR, 84532, 0, _baseConfirmations()
            ),
            address(token),
            address(asset)
        );
        vm.chainId(84532);
        vault = new HedgeVault(
            CcipEndpoint.Config(
                BASE_OPERATOR, address(baseRouter), BASE_SELECTOR, HEDERA_SELECTOR, 296, _baseConfirmations(), 0
            ),
            address(asset)
        );
        vm.prank(BASE_OPERATOR);
        vault.configurePeer(address(lending));
        vm.prank(OPERATOR);
        lending.configurePeer(address(vault));
        require(lending.instanceId() == vault.instanceId(), "pair mismatch");
        _associate(OPERATOR);
        _associate(BORROWER);
        token.mint(OPERATOR, 1000000000);
        asset.mint(OWNER, 1000000000);
        vm.prank(OPERATOR);
        token.approve(address(lending), type(uint256).max);
        vm.prank(BORROWER);
        token.approve(address(lending), type(uint256).max);
        vm.prank(OWNER);
        asset.approve(address(vault), type(uint256).max);
        vm.prank(OPERATOR);
        lending.deposit(10000000);
    }

    function _baseConfirmations() internal pure virtual returns (uint16) {
        return 0;
    }

    function _associate(address account) internal {
        vm.prank(account);
        require(hts.associateToken(account, address(token)) == 22);
    }

    function _terms() internal view returns (HedgeTypes.Terms memory) {
        return HedgeTypes.Terms(
            BORROWER,
            BORROWER,
            1000000,
            1010000,
            address(asset),
            2000000,
            OWNER,
            RETURN,
            RECOVERY,
            uint64(block.timestamp + 600),
            uint64(block.timestamp + 1200),
            86400,
            30,
            keccak256("fixed-total-policy-v1"),
            0
        );
    }

    function _publish(HedgeTypes.Terms memory terms) internal returns (bytes32 offerId) {
        vm.prank(OPERATOR);
        return lending.publishOffer(terms);
    }

    function _accept() internal returns (bytes32 id) {
        return _acceptTerms(_terms());
    }

    function _acceptTerms(HedgeTypes.Terms memory terms) internal returns (bytes32 id) {
        bytes32 offerId = _publish(terms);
        bytes32 hash = lending.getOffer(offerId).termsHash;
        vm.prank(BORROWER);
        return lending.accept(offerId, hash);
    }

    function _send(CcipEndpoint endpoint, bytes32 id, HedgeTypes.Kind kind) internal {
        bytes32 operation = endpoint.operationId(id, kind);
        uint256 fee = endpoint.quoteMessage(operation, 1000000);
        endpoint.sendMessage{value: fee}(operation, 1000000);
    }

    function _authorize(bytes32 id) internal {
        _send(lending, id, HedgeTypes.Kind.Agreement);
        hederaRouter.deliverWithPolicy(hederaRouter.count(), baseRouter);
    }

    function _lock(bytes32 id) internal {
        bytes32 hash = lending.getLoan(id).agreementHash;
        vm.prank(OWNER);
        vault.lock(id, hash);
    }

    function _confirm(bytes32 id) internal {
        _send(vault, id, HedgeTypes.Kind.Custody);
        baseRouter.deliverWithPolicy(baseRouter.count(), hederaRouter);
    }

    function _funded() internal returns (bytes32 id) {
        id = _accept();
        _authorize(id);
        _lock(id);
        _confirm(id);
    }

    function _repay(bytes32 id) internal {
        token.mint(BORROWER, 10000);
        vm.prank(BORROWER);
        lending.repay(id, 1010000);
    }

    function _outcome(bytes32 id) internal {
        _send(lending, id, HedgeTypes.Kind.Outcome);
        hederaRouter.deliverWithPolicy(hederaRouter.count(), baseRouter);
    }

    function _message(MockRouter.Packet memory packet) internal pure returns (Client.Any2EVMMessage memory) {
        return Client.Any2EVMMessage(
            packet.id, packet.source, abi.encode(packet.sender), packet.data, new Client.EVMTokenAmount[](0)
        );
    }

    function _assertCapital() internal view {
        require(lending.capital(OPERATOR) >= lending.reservedCapital(OPERATOR), "overcommitted capital");
        require(token.balanceOf(address(lending)) >= lending.capital(OPERATOR), "insolvent lending");
        require(asset.balanceOf(address(vault)) >= vault.totalLocked(), "insolvent custody");
    }
}
