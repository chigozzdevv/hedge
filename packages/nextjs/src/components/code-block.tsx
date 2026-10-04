import { Fragment } from "react";
import { codeToTokens } from "shiki";
import { CopyButton } from "./copy-button";

export async function CodeBlock({
  code,
  label = "Terminal",
  language = "bash",
}: {
  code: string;
  label?: string;
  language?: "text" | "bash" | "dotenv" | "json" | "tsx";
}) {
  const highlighted =
    language === "text"
      ? undefined
      : await codeToTokens(code, { lang: language, theme: "catppuccin-mocha" });

  return (
    <div className="code-block">
      <div className="flex items-center justify-between border-b border-white/8 px-5 py-3">
        <span className="text-xs text-muted">{label}</span>
        <CopyButton code={code} label={label} />
      </div>
      <pre tabIndex={0} aria-label={`${label} code`}>
        <code className={`language-${language}`}>
          {highlighted
            ? highlighted.tokens.map((line, lineIndex) => (
                <Fragment key={lineIndex}>
                  {lineIndex > 0 && "\n"}
                  {line.map((token, tokenIndex) => (
                    <span key={tokenIndex} style={{ color: token.color }}>
                      {token.content}
                    </span>
                  ))}
                </Fragment>
              ))
            : code}
        </code>
      </pre>
    </div>
  );
}
