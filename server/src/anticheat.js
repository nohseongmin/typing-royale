/** 누적 타수의 상한. 사람이 직접 입력했는지 증명하는 봇 탐지 기능은 아니다. */
export const MAX_STROKES_PER_SEC = 30;
export const PACE_SLACK_STROKES = 80; // 네트워크 지연으로 완료 신고가 몰리는 경우의 여유
export const SUSPECT_STRIKES = 3;

/* 판이 시작된 뒤 서버가 인정할 수 있는 누적 입력 예산. */
export const withinHumanPace = (totalStrokes, elapsedMs) =>
  totalStrokes <= Math.max(0, elapsedMs) / 1000 * MAX_STROKES_PER_SEC + PACE_SLACK_STROKES;
