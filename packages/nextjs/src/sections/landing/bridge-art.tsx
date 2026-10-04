export function BridgeArt() {
  return (
    <div className="bridge-art">
      <svg
        viewBox="0 0 960 340"
        fill="none"
        role="img"
        aria-label="Base collateral connects through Hedge to borrowing in a Hedera app."
      >
        <defs>
          <linearGradient
            id="bridge-line"
            x1="240"
            y1="170"
            x2="730"
            y2="170"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#55515f" />
            <stop offset=".45" stopColor="#9f81ff" />
            <stop offset="1" stopColor="#55515f" />
          </linearGradient>
          <linearGradient
            id="bridge-face"
            x1="0"
            y1="0"
            x2="220"
            y2="150"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#232128" />
            <stop offset="1" stopColor="#111014" />
          </linearGradient>
          <linearGradient
            id="bridge-core"
            x1="430"
            y1="100"
            x2="530"
            y2="210"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#8b65ff" />
            <stop offset="1" stopColor="#3d2099" />
          </linearGradient>
          <radialGradient id="bridge-glow">
            <stop stopColor="#7c4eff" stopOpacity=".23" />
            <stop offset="1" stopColor="#7c4eff" stopOpacity="0" />
          </radialGradient>
          <filter id="bridge-shadow" x="-50%" y="-50%" width="200%" height="220%">
            <feDropShadow dx="0" dy="18" stdDeviation="16" floodColor="#000" floodOpacity=".6" />
          </filter>
          <pattern id="bridge-grid" width="45" height="25" patternUnits="userSpaceOnUse">
            <path d="M45 0H0v25" stroke="#9384b8" strokeOpacity=".1" />
          </pattern>
          <linearGradient
            id="grid-fade"
            x1="480"
            y1="180"
            x2="480"
            y2="330"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="white" stopOpacity="0" />
            <stop offset=".55" stopColor="white" />
            <stop offset="1" stopColor="white" stopOpacity="0" />
          </linearGradient>
          <mask id="grid-mask">
            <rect x="60" y="200" width="840" height="130" fill="url(#grid-fade)" />
          </mask>
        </defs>
        <ellipse cx="480" cy="170" rx="400" ry="160" fill="url(#bridge-glow)" />
        <g mask="url(#grid-mask)">
          <path d="M200 190h560l160 140H40l160-140Z" fill="url(#bridge-grid)" />
        </g>
        <path
          d="M282 179c74 0 83-26 139-26m118 0c56 0 65 26 139 26"
          stroke="url(#bridge-line)"
          strokeWidth="2"
        />
        <path
          d="M282 200c72 0 84 39 139 39h118c55 0 67-39 139-39"
          stroke="#776497"
          strokeOpacity=".3"
          strokeDasharray="5 7"
        />
        <circle className="bridge-pulse" cx="354" cy="167" r="4" fill="#ad90ff" />
        <circle className="bridge-pulse pulse-delay" cx="606" cy="167" r="4" fill="#ad90ff" />
        <g transform="translate(72 102) rotate(-7 110 76)" filter="url(#bridge-shadow)">
          <rect x="7" y="11" width="220" height="154" rx="18" fill="#17151e" stroke="#40334f" />
          <rect width="220" height="154" rx="18" fill="url(#bridge-face)" stroke="#5b5467" />
          <circle cx="38" cy="37" r="15" fill="#3567f6" />
          <path d="M23 37h23" stroke="#fff" strokeWidth="3.5" />
          <text x="64" y="42" fill="#f0edf7" fontSize="18" fontWeight="600">
            Base
          </text>
          <text x="24" y="88" fill="#aaa3b6" fontSize="12">
            YOUR COLLATERAL
          </text>
          <rect x="24" y="103" width="172" height="29" rx="6" fill="#24202d" stroke="#41374e" />
          <path
            d="M37 116v-3a4 4 0 0 1 8 0v3m-9 0h10v8H36v-8Z"
            stroke="#b59ae9"
            strokeWidth="1.3"
          />
          <text x="55" y="122" fill="#ded6eb" fontSize="12">
            Pledge assets
          </text>
        </g>
        <g filter="url(#bridge-shadow)">
          <circle cx="480" cy="170" r="78" stroke="#8b68c4" strokeOpacity=".18" />
          <circle cx="480" cy="170" r="66" fill="#18131f" stroke="#5d457b" />
          <rect
            x="433"
            y="128"
            width="94"
            height="94"
            rx="25"
            fill="#32146a"
            stroke="#8857d9"
            transform="rotate(-7 480 175)"
          />
          <rect
            x="433"
            y="117"
            width="94"
            height="94"
            rx="25"
            fill="url(#bridge-core)"
            stroke="#bc9bff"
            transform="rotate(-7 480 164)"
          />
          <path d="M458 143h12v20l20-12v-8h12v42h-12v-20l-20 12v8h-12v-42Z" fill="#fff" />
        </g>
        <g transform="translate(668 102) rotate(7 110 76)" filter="url(#bridge-shadow)">
          <rect x="-7" y="11" width="220" height="154" rx="18" fill="#17151e" stroke="#40334f" />
          <rect width="220" height="154" rx="18" fill="url(#bridge-face)" stroke="#5b5467" />
          <circle cx="38" cy="37" r="15" fill="#eeeaf5" />
          <path d="M33 28v18m10-18v18M33 34h10M33 40h10" stroke="#17131d" strokeWidth="2" />
          <text x="64" y="42" fill="#f0edf7" fontSize="18" fontWeight="600">
            Hedera
          </text>
          <text x="24" y="88" fill="#aaa3b6" fontSize="12">
            YOUR APP
          </text>
          <rect x="24" y="103" width="172" height="29" rx="6" fill="#24202d" stroke="#41374e" />
          <path d="M36 121h11m-4-4 4 4-4 4" stroke="#b59ae9" strokeWidth="1.3" />
          <text x="55" y="122" fill="#ded6eb" fontSize="12">
            Borrow to continue
          </text>
        </g>
        <text x="480" y="295" textAnchor="middle" fill="#817789" fontSize="10" letterSpacing="3">
          COLLATERAL → CREDIT
        </text>
      </svg>
    </div>
  );
}
