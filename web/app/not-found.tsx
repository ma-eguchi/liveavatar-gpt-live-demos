import Link from "next/link";

export default function NotFound() {
  return (
    <div className="container page empty">
      ページが見つかりませんでした。
      <br />
      <Link href="/" className="btn" style={{ marginTop: 16 }}>
        トップへ戻る
      </Link>
    </div>
  );
}
