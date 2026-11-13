import "../styles/dai_mascot.css";

/** 沿用 Dai 原有的欢迎形象，供项目主页与聊天空状态共用。 */
export function DaiMascot() {
  return (
    <svg className="dai-mascot" viewBox="0 0 112 112" aria-hidden="true" focusable="false">
      <ellipse className="dai-mascot-shadow" cx="55" cy="102" rx="20" ry="3" />
      <g className="dai-mascot-body">
        <path
          className="dai-mascot-outline"
          d="M37 19h15c23 0 38 14 38 34S75 87 52 87H37c-8 0-13-5-13-13V32c0-8 5-13 13-13Z"
        />
        <g className="dai-mascot-eyes">
          <rect x="42" y="43" width="5" height="11" rx="2.5" />
          <rect x="61" y="43" width="5" height="11" rx="2.5" />
        </g>
        <path className="dai-mascot-smile" d="M49 63q5 4 10 0" />
      </g>
    </svg>
  );
}
