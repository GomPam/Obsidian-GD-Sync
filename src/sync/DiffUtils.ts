export class DiffUtils {
    /**
     * Compute a 2-way diff using Longest Common Subsequence (LCS) and insert Git-style merge markers.
     * Optimized with Int32Array for better memory and performance.
     */
    static mergeTexts(localText: string, remoteText: string): string {
        const localLines = localText.split(/\r?\n/);
        const remoteLines = remoteText.split(/\r?\n/);

        const n = localLines.length;
        const m = remoteLines.length;

        // 너무 큰 파일은 O(N*M) DP 연산 시 브라우저 스레드 프리징 위험이 있으므로, 
        // 일정 크기 이상이면 파일 전체 단위 병합으로 Fallback 처리 (약 5000 x 5000 사이즈 = 25M 이상)
        if (n * m > 25000000) {
            return `<<<<<<< LOCAL\n${localText}\n=======\n${remoteText}\n>>>>>>> REMOTE`;
        }

        // DP 초기화
        const dp: Int32Array[] = new Array(n + 1);
        for (let i = 0; i <= n; i++) {
            dp[i] = new Int32Array(m + 1);
        }

        // LCS DP 테이블 채우기
        for (let i = 1; i <= n; i++) {
            const row = dp[i];
            const prevRow = dp[i - 1];
            // TypeScript strict check path
            if (!row || !prevRow) continue; 

            for (let j = 1; j <= m; j++) {
                if (localLines[i - 1] === remoteLines[j - 1]) {
                    row[j] = (prevRow[j - 1] ?? 0) + 1;
                } else {
                    row[j] = Math.max(prevRow[j] ?? 0, row[j - 1] ?? 0);
                }
            }
        }

        // 역추적(Backtrack)하여 Diff 작업 추출
        let i = n;
        let j = m;
        const actions: { type: 'common' | 'local_only' | 'remote_only', line: string }[] = [];

        while (i > 0 && j > 0) {
            const row = dp[i];
            const prevRow = dp[i - 1];
            if (!row || !prevRow) break;

            if (localLines[i - 1] === remoteLines[j - 1]) {
                actions.push({ type: 'common', line: localLines[i - 1]! });
                i--;
                j--;
            } else if ((prevRow[j] ?? 0) > (row[j - 1] ?? 0)) {
                actions.push({ type: 'local_only', line: localLines[i - 1]! });
                i--;
            } else {
                actions.push({ type: 'remote_only', line: remoteLines[j - 1]! });
                j--;
            }
        }
        while (i > 0) {
            actions.push({ type: 'local_only', line: localLines[i - 1]! });
            i--;
        }
        while (j > 0) {
            actions.push({ type: 'remote_only', line: remoteLines[j - 1]! });
            j--;
        }

        // 역추적 했으므로 배열을 뒤집음
        actions.reverse();

        // 충돌 마커 조합
        const mergedLines: string[] = [];
        let idx = 0;
        while (idx < actions.length) {
            const action = actions[idx];
            if (!action) {
                idx++;
                continue;
            }

            if (action.type === 'common') {
                mergedLines.push(action.line);
                idx++;
            } else {
                const localChunk: string[] = [];
                const remoteChunk: string[] = [];
                
                // 공통 부분이 나오기 전까지 변경된 덩어리(Chunk) 모두 수집
                while (idx < actions.length) {
                    const curr = actions[idx];
                    if (!curr || curr.type === 'common') break;

                    if (curr.type === 'local_only') localChunk.push(curr.line);
                    if (curr.type === 'remote_only') remoteChunk.push(curr.line);
                    idx++;
                }
                
                mergedLines.push('<<<<<<< LOCAL');
                mergedLines.push(...localChunk);
                mergedLines.push('=======');
                mergedLines.push(...remoteChunk);
                mergedLines.push('>>>>>>> REMOTE');
            }
        }

        return mergedLines.join('\n');
    }
}
