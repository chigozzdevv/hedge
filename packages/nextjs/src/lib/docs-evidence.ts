export const testRuns = [
  {
    title: "Borrow and repay with collateral · 2026-10-04 · SDK",
    description:
      "Borrowed 0.1 Hedera USDC against 0.2 Base USDC. Collateral repayment paid 0.102 Base USDC to the operator and returned 0.098 Base USDC to the borrower. Confirmed Repaid, collateral settled and 0 due. Hedera capital remained 4.9 USDC.",
    receipts: [
      {
        step: "Accept loan",
        label: "0xec81f3df…ef88af ↗",
        url: "https://hashscan.io/testnet/transaction/0xec81f3df9694a61f8fb36e59e71cd7f993eca141322cba063b2aa29a5fef88af",
      },
      {
        step: "Lock collateral",
        label: "0x40e45a1c…a6f017 ↗",
        url: "https://sepolia.basescan.org/tx/0x40e45a1c8ad325507d60ee68ef115d53f6fd9439bfe2e38862f63b7acaa6f017",
      },
      {
        step: "Receive funds",
        label: "0xe85ff5dd…45d292 ↗",
        url: "https://hashscan.io/testnet/transaction/0xe85ff5ddd2e92b6d81a0c838ab04aaf7be1fba86a4caafa179c12ae5a145d292",
      },
      {
        step: "Authorize collateral payment",
        label: "0x6ea76192…e0b89a ↗",
        url: "https://hashscan.io/testnet/transaction/0x6ea76192ca5d2f18a3202428c1caf97062becfde6fcfa8fae71c7d7f68e0b89a",
      },
      {
        step: "Pay operator; return remainder",
        label: "0x431b26c7…2671ed ↗",
        url: "https://sepolia.basescan.org/tx/0x431b26c7724f18ab5a19fe058806d5291a4761ce34427d6f943cd325262671ed",
      },
      {
        step: "Confirm repayment",
        label: "0xc5de9e8e…bc8501 ↗",
        url: "https://hashscan.io/testnet/transaction/0xc5de9e8e4c4a36fc079fbd554bfa11bec2b75ab58a053951948339af73bc8501",
      },
    ],
  },
  {
    title: "Borrow, swap, repay and claim · 2026-10-02 · Browser",
    description:
      "Confirmed 0.1 USDC loan, SaucerSwap swap, Hedera wallet repayment and Base collateral claim. Recorded timing: 165s acceptance to payout, 42s lock to payout and 691s full lifecycle, including user actions.",
    receipts: [
      {
        step: "Accept loan",
        label: "0x56d5e827…083175 ↗",
        url: "https://hashscan.io/testnet/transaction/0x56d5e827cb0d1f14b120067fb89656708872431fec564ea2775c6aeadc083175",
      },
      {
        step: "Deliver agreement to Base",
        label: "0x32680aa0…cf3ab7 ↗",
        url: "https://ccip.chain.link/msg/0x32680aa0b2f32790478106f166cc713c9b24757200d3cc4a1635fa5374cf3ab7",
      },
      {
        step: "Lock collateral",
        label: "0xcee36861…b4c261 ↗",
        url: "https://sepolia.basescan.org/tx/0xcee36861b57da105aeeb7b3ac01d26836eeab5c8cf1ef5f423c819ba57b4c261",
      },
      {
        step: "Confirm custody on Hedera",
        label: "0xc5024369…955b08 ↗",
        url: "https://ccip.chain.link/msg/0xc502436907b7de3053ce9f13956d83f2d2630fd12f2243441606fa7a12955b08",
      },
      {
        step: "Receive 0.1 USDC",
        label: "0xddc63e29…43379a ↗",
        url: "https://hashscan.io/testnet/transaction/0xddc63e291c37104f573a883e88172370313106e461bef7059bc9b4910d43379a",
      },
      {
        step: "Swap 0.01 USDC → 0.00441962 HBAR",
        label: "0x6c71a2db…ddd3d6 ↗",
        url: "https://hashscan.io/testnet/transaction/0x6c71a2db50cbf64cce4d9b9d872c919eabb16a364ca9beca41c9931ae5ddd3d6",
      },
      {
        step: "Repay loan",
        label: "0x59e126ae…a73eb8 ↗",
        url: "https://hashscan.io/testnet/transaction/0x59e126aef78c9157b58a5b0fc8afe4d2fb722c9261811b9187586bdd24a73eb8",
      },
      {
        step: "Deliver repayment outcome to Base",
        label: "0x7b20ae07…994eeb ↗",
        url: "https://ccip.chain.link/msg/0x7b20ae074fd40e386dd1752d80d85a1a43ece29e897dbaa067c43fca97994eeb",
      },
      {
        step: "Claim collateral",
        label: "0xa7a92d20…c2e984 ↗",
        url: "https://sepolia.basescan.org/tx/0xa7a92d20fbaf7db85fa4568307a54eae31aecbe1d80d0dbc112bd95360c2e984",
      },
    ],
  },
] as const;
