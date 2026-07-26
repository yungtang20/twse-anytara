import { useEffect, useState } from "react";

/** Self-contained clock that updates every second without triggering parent re-renders. */
export function ClockBadge() {
  const [time, setTime] = useState(() =>
    new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" }))
  );

  useEffect(() => {
    const timer = setInterval(() => {
      setTime(new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" })));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const timeString = time.toLocaleString("zh-TW", {
    timeZone: "Asia/Taipei",
    hour12: false,
  });

  return <span className="text-xs">台北時間 {timeString}</span>;
}
