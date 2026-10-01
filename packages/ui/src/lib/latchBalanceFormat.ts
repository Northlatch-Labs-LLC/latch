/**
 * 余额展示的纯格式化函数：不携带任何 runtime import（@/ 别名在根目录 tsx 直跑的
 * 单测里解析不到，见 packages/ui/test/latchGatewayQuotaError.test.ts 的导入说明），
 * 因此单独放 lib，供组件与单测共用。
 */

/** 余额展示：≥$0.01 保留两位小数；正但不足一分钱时显示 <$0.01，避免被舍入成“已耗尽”。 */
export function formatLatchBalanceUsd(balanceMicros: number): string {
  const usd = balanceMicros / 1_000_000;
  if (usd > 0 && usd < 0.01) {
    return "<$0.01";
  }
  return `$${usd.toFixed(2)}`;
}
