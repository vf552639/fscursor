import React from "react";

/**
 * Причина, по которой массовый прогон НЕ начался: «уже провижинится», «только
 * десктоп», отказ самой команды. Молчащая кнопка неотличима от сломанной.
 *
 * `role="alert"` без вариантов, в отличие от соседнего `RunNoticeBanner`:
 * там половина исходов — успех, а здесь их нет вовсе — сюда попадает только то,
 * что не состоялось.
 *
 * Живёт ровно столько, сколько живёт набор, на котором случился отказ: гасит
 * его `useBulkProvision` по смене выделения, а не время и не следующий рендер.
 */
export default function BulkProvisionErrorBanner({ message }: { message: string }) {
  return (
    <div role="alert" style={{marginBottom:12,padding:"10px 12px",background:"#fee2e2",borderRadius:8,color:"#991b1b",fontSize:13}}>
      {message}
    </div>
  );
}
