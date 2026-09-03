// Череп заставки: авторский вектор по мотивам референсов владельца —
// панишеровский силуэт с клыками-сталактитами, тлеющие красным глазницы, кровь,
// вокруг — тонкий геометрический сигил. Анимации — в global.css (классы rrs-*).
export function SplashSkull() {
  return (
    <svg className="rrs" viewBox="0 0 300 420" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="rrsBone" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#c9c6c1" />
          <stop offset="0.5" stopColor="#93908b" />
          <stop offset="0.85" stopColor="#514f4b" />
          <stop offset="1" stopColor="#383633" />
        </linearGradient>
        <radialGradient id="rrsShade" cx="0.5" cy="0.3" r="0.8">
          <stop offset="0" stopColor="#d9d6d1" />
          <stop offset="0.55" stopColor="#96938e" />
          <stop offset="0.85" stopColor="#5a5854" />
          <stop offset="1" stopColor="#3d3b38" />
        </radialGradient>
        <radialGradient id="rrsGlow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#ff6b57" stopOpacity="0.95" />
          <stop offset="0.45" stopColor="#e01212" stopOpacity="0.6" />
          <stop offset="1" stopColor="#b00000" stopOpacity="0" />
        </radialGradient>
        <filter height="220%" id="rrsBlur3" width="220%" x="-60%" y="-60%">
          <feGaussianBlur stdDeviation="3" />
        </filter>
        <filter height="260%" id="rrsBlur6" width="260%" x="-80%" y="-80%">
          <feGaussianBlur stdDeviation="6" />
        </filter>
        <clipPath id="rrsEyeL">
          <path d="M 82 148 Q 110 130 140 168 L 138 192 Q 104 200 84 178 Q 74 162 82 148 Z" />
        </clipPath>
        <clipPath id="rrsEyeR">
          <path d="M 218 148 Q 190 130 160 168 L 162 192 Q 196 200 216 178 Q 226 162 218 148 Z" />
        </clipPath>
      </defs>

      {/* сигил: статичная ось + два кольца, крутящиеся в разные стороны */}
      <g className="rrs-sigil" fill="none" opacity="0.55" stroke="#9a9a9a" strokeWidth="0.8">
        <g className="rrs-ring-a">
          <circle cx="150" cy="160" opacity="0.7" r="118" />
          <line x1="150" x2="150" y1="28" y2="36" />
          <line x1="150" x2="150" y1="284" y2="292" />
          <line x1="16" x2="24" y1="160" y2="160" />
          <line x1="276" x2="284" y1="160" y2="160" />
        </g>
        <g className="rrs-ring-b">
          <circle cx="150" cy="160" opacity="0.45" r="130" strokeDasharray="60 38 120 50" />
          <circle cx="150" cy="160" opacity="0.5" r="104" strokeDasharray="10 200 34 120" />
        </g>
        <line x1="150" x2="150" y1="2" y2="26" />
        <circle cx="150" cy="12" r="4" />
        <line x1="146" x2="154" y1="6" y2="6" />
        <line x1="150" x2="150" y1="296" y2="414" />
        <path d="M150 380 l5 6 -5 6 -5 -6 z" />
        <circle cx="150" cy="402" r="3.5" />
        <line x1="56" x2="63" y1="264" y2="271" />
        <line x1="63" x2="56" y1="264" y2="271" />
        <line x1="237" x2="244" y1="264" y2="271" />
        <line x1="244" x2="237" y1="264" y2="271" />
        <circle cx="34" cy="116" r="2.5" />
        <circle cx="266" cy="116" r="2.5" />
      </g>

      {/* кровь позади черепа: выступает из-под силуэта */}
      <g className="rrs-blood" fill="#8f0b0b" opacity="0.6">
        <rect height="122" rx="2" width="4" x="86" y="170" />
        <rect height="82" rx="1.3" width="2.6" x="78" y="180" />
        <rect height="150" rx="2.2" width="4.5" x="211" y="168" />
        <rect height="96" rx="1.4" width="2.8" x="220" y="182" />
        <rect height="112" rx="1.5" width="3" x="100" y="220" />
        <rect height="128" rx="1.5" width="3" x="198" y="226" />
      </g>

      <g className="rrs-skull">
        {/* силуэт: купол, скулы, челюсть */}
        <path
          d="M150 46 C 98 46, 60 88, 60 142 C 60 164, 70 178, 90 182 L 70 202 Q 86 236, 108 244 L 108 250 Q 108 256, 114 256 L 186 256 Q 192 256, 192 250 L 192 244 Q 214 236, 230 202 L 210 182 C 230 178, 240 164, 240 142 C 240 88, 202 46, 150 46 Z"
          fill="url(#rrsShade)"
        />
        {/* тень под бровями */}
        <path
          d="M 78 140 Q 150 116 222 140 L 222 158 Q 150 138 78 158 Z"
          fill="#000"
          filter="url(#rrsBlur6)"
          opacity="0.16"
        />
        {/* глазницы */}
        <path d="M 82 148 Q 110 130 140 168 L 138 192 Q 104 200 84 178 Q 74 162 82 148 Z" fill="#0a0a0a" />
        <path d="M 218 148 Q 190 130 160 168 L 162 192 Q 196 200 216 178 Q 226 162 218 148 Z" fill="#0a0a0a" />

        {/* угли в глазницах: вспыхивают и пульсируют */}
        <g className="rrs-eyes">
          <g className="rrs-eyes-pulse">
            <g clipPath="url(#rrsEyeL)">
              <ellipse cx="110" cy="182" fill="url(#rrsGlow)" filter="url(#rrsBlur3)" rx="34" ry="17" />
              <ellipse cx="112" cy="184" fill="#ff8a70" filter="url(#rrsBlur3)" opacity="0.75" rx="15" ry="7.5" />
            </g>
            <g clipPath="url(#rrsEyeR)">
              <ellipse cx="190" cy="182" fill="url(#rrsGlow)" filter="url(#rrsBlur3)" rx="34" ry="17" />
              <ellipse cx="188" cy="184" fill="#ff8a70" filter="url(#rrsBlur3)" opacity="0.75" rx="15" ry="7.5" />
            </g>
            <ellipse cx="111" cy="176" fill="url(#rrsGlow)" filter="url(#rrsBlur6)" opacity="0.35" rx="26" ry="13" />
            <ellipse cx="189" cy="176" fill="url(#rrsGlow)" filter="url(#rrsBlur6)" opacity="0.35" rx="26" ry="13" />
          </g>
        </g>

        {/* нос */}
        <path d="M 147 198 C 136 210, 132 232, 141 246 C 146 242, 147.5 216, 147 198 Z" fill="#0a0a0a" />
        <path d="M 153 198 C 164 210, 168 232, 159 246 C 154 242, 152.5 216, 153 198 Z" fill="#0a0a0a" />

        {/* тень стыка челюсти и зубов — под зубами, чтобы щели остались тёмными */}
        <rect fill="#000" filter="url(#rrsBlur3)" height="8" opacity="0.35" width="94" x="103" y="250" />
        {/* зубы-сталактиты, середина длиннее */}
        <g fill="url(#rrsBone)">
          <path d="M 103 246 L 105 292 Q 111.2 300 117.4 292 L 119.4 246 Z" />
          <path d="M 122.4 246 L 124.4 322 Q 130.6 330 136.8 322 L 138.8 246 Z" />
          <path d="M 141.8 246 L 143.8 348 Q 150 356 156.2 348 L 158.2 246 Z" />
          <path d="M 161.2 246 L 163.2 322 Q 169.4 330 175.6 322 L 177.6 246 Z" />
          <path d="M 180.6 246 L 182.6 292 Q 188.8 300 195 292 L 197 246 Z" />
        </g>

        {/* трещины купола */}
        <g fill="none" opacity="0.65" stroke="#45423e" strokeWidth="0.9">
          <path d="M152 50 C 147 70, 156 88, 149 108 C 145 120, 152 130, 149 138" />
          <path d="M149 92 C 158 97, 163 104, 172 106" />
          <path d="M98 96 C 107 104, 110 116, 105 126" />
          <path d="M198 76 C 194 88, 199 98, 195 110" />
        </g>
      </g>

      {/* кровь поверх кости: из глазниц, со скул и зубов */}
      <g className="rrs-blood">
        <g fill="#c11212" opacity="0.85">
          <rect height="52" rx="1.1" width="2.2" x="98" y="192" />
          <rect height="66" rx="0.8" width="1.6" x="106" y="196" />
          <rect height="46" rx="1.2" width="2.4" x="196" y="194" />
          <rect height="74" rx="0.8" width="1.6" x="202" y="190" />
          <rect height="48" rx="1" width="2" x="72" y="204" />
          <rect height="42" rx="1" width="2" x="226" y="206" />
          <rect height="38" rx="0.9" width="1.8" x="124.5" y="286" />
          <rect height="32" rx="0.9" width="1.8" x="174" y="300" />
          <rect height="26" rx="0.8" width="1.6" x="141" y="330" />
        </g>
        <g fill="#b31010">
          <circle cx="66" cy="196" opacity="0.7" r="1.8" />
          <circle cx="62" cy="226" opacity="0.5" r="1.1" />
          <circle cx="236" cy="198" opacity="0.65" r="1.6" />
          <circle cx="242" cy="232" opacity="0.5" r="1" />
          <circle cx="108" cy="296" opacity="0.55" r="1.3" />
          <circle cx="194" cy="300" opacity="0.55" r="1.4" />
          <circle cx="84" cy="144" opacity="0.45" r="1.2" />
          <circle cx="216" cy="140" opacity="0.45" r="1.3" />
        </g>
      </g>
    </svg>
  );
}
