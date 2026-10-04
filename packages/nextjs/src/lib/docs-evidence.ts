export const demoEvidence = {
  title: "Borrow, swap, repay and collateral return",
  description:
    "Our demo integration in packages/nextjs completed the full cycle using the public integration path on Hedera Testnet and Base Sepolia.",
  receipts: [
    {
      step: "Accept loan",
      label: "0x93dd275d…7cca58 ↗",
      url: "https://hashscan.io/testnet/transaction/0x93dd275d8f77db3880db265109267f6990e20404622bd128f85d2f377e7cca58",
    },
    {
      step: "Lock collateral",
      label: "0xac63ce67…7b4a99 ↗",
      url: "https://sepolia.basescan.org/tx/0xac63ce67feae2a590b9ac91d2e58bef314c6a37bcd4374ad3f901c34ef7b4a99",
    },
    {
      step: "Receive funds",
      label: "0x695c6d90…de9a88 ↗",
      url: "https://hashscan.io/testnet/transaction/0x695c6d903053a61a7f7a1d8e21b40e0335cc79d9b9db6461f0a1eb1b1ade9a88",
    },
    {
      step: "Swap USDC → HBAR",
      label: "0x623a52f9…e1ca83 ↗",
      url: "https://hashscan.io/testnet/transaction/0x623a52f98bdbc8279a12a11169dedb490027e629ade020630a34f23954e1ca83",
    },
    {
      step: "Authorize repayment",
      label: "0xbf8bd7a0…15c4dc ↗",
      url: "https://hashscan.io/testnet/transaction/0xbf8bd7a01eb174f8ae02d52133937a3475e9d67c403d28d371120a81cd15c4dc",
    },
    {
      step: "Repay with collateral and return remainder",
      label: "0x465b21b3…044bfd ↗",
      url: "https://sepolia.basescan.org/tx/0x465b21b38e09347454ea5f9d3fd9190939d7dead2ab1d944077b688a2c044bfd",
    },
    {
      step: "Confirm repayment",
      label: "0x6453cfc8…4612ae ↗",
      url: "https://hashscan.io/testnet/transaction/0x6453cfc88403f159987f143b49a55969b8600d9f408b2c6c95e535d7624612ae",
    },
  ],
} as const;
