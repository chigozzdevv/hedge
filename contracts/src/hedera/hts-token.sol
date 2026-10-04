// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Selected signatures from Hiero's IHederaTokenService; see the root README.md.
interface IHtsTokenService {
    struct FixedFee {
        int64 amount;
        address tokenId;
        bool useHbarsForPayment;
        bool useCurrentTokenForPayment;
        address feeCollector;
    }

    struct FractionalFee {
        int64 numerator;
        int64 denominator;
        int64 minimumAmount;
        int64 maximumAmount;
        bool netOfTransfers;
        address feeCollector;
    }

    struct RoyaltyFee {
        int64 numerator;
        int64 denominator;
        int64 amount;
        address tokenId;
        bool useHbarsForPayment;
        address feeCollector;
    }
    function getTokenType(address token) external returns (int64 responseCode, int32 tokenType);
    function getTokenCustomFees(address token)
        external
        returns (int64 responseCode, FixedFee[] memory, FractionalFee[] memory, RoyaltyFee[] memory);
    function associateToken(address account, address token) external returns (int64 responseCode);
    function transferFrom(address token, address from, address to, uint256 amount) external returns (int64 responseCode);
    function transferToken(address token, address from, address to, int64 amount) external returns (int64 responseCode);
}

library HtsToken {
    address internal constant SERVICE = address(0x167);
    int64 internal constant SUCCESS = 22;
    int64 internal constant ALREADY_ASSOCIATED = 194;
    error HtsFailure(int64 responseCode);
    error InvalidHtsToken();
    error InexactTransfer();

    function associate(address token) internal {
        (int64 code, int32 tokenType) = IHtsTokenService(SERVICE).getTokenType(token);
        if (code != SUCCESS || tokenType != 0) {
            revert InvalidHtsToken();
        }
        _noCustomFees(token);
        int64 associationCode = IHtsTokenService(SERVICE).associateToken(address(this), token);
        if (associationCode != ALREADY_ASSOCIATED) {
            _check(associationCode);
        }
    }

    function balance(address token, address account) internal view returns (uint256) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSignature("balanceOf(address)", account));
        if (!ok || data.length != 32) {
            revert InvalidHtsToken();
        }
        return abi.decode(data, (uint256));
    }

    function pull(address token, address from, uint256 amount) internal {
        _noCustomFees(token);
        uint256 source = balance(token, from);
        uint256 target = balance(token, address(this));
        _check(IHtsTokenService(SERVICE).transferFrom(token, from, address(this), amount));
        _exact(token, from, address(this), source, target, amount);
    }

    function push(address token, address to, uint256 amount) internal {
        _noCustomFees(token);
        if (amount > uint256(uint64(type(int64).max))) {
            revert InexactTransfer();
        }
        uint256 source = balance(token, address(this));
        uint256 target = balance(token, to);
        _check(IHtsTokenService(SERVICE).transferToken(token, address(this), to, int64(uint64(amount))));
        _exact(token, address(this), to, source, target, amount);
    }

    function _exact(address token, address from, address to, uint256 source, uint256 target, uint256 amount)
        private
        view
    {
        if (balance(token, from) + amount != source || balance(token, to) != target + amount) {
            revert InexactTransfer();
        }
    }

    function _check(int64 code) private pure {
        if (code != SUCCESS) {
            revert HtsFailure(code);
        }
    }

    function _noCustomFees(address token) private {
        (
            int64 code,
            IHtsTokenService.FixedFee[] memory fixedFees,
            IHtsTokenService.FractionalFee[] memory fractionalFees,
            IHtsTokenService.RoyaltyFee[] memory royaltyFees
        ) = IHtsTokenService(SERVICE).getTokenCustomFees(token);
        _check(code);
        if (fixedFees.length != 0 || fractionalFees.length != 0 || royaltyFees.length != 0) {
            revert InvalidHtsToken();
        }
    }
}
