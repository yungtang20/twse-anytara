-- Some legacy Yahoo-imported rows stored volume in lots while newer TWSE/TPEX
-- rows use shares. The legacy rows are identifiable by both their sub-million
-- volume and an amount/close/volume ratio below 0.002. Multiplying by 1,000
-- makes stock_price.volume consistently represent shares.
update public.stock_price
set volume = volume * 1000
where volume > 0
  and volume < 1000000
  and close > 0
  and amount > 0
  and amount::numeric / (close * volume) < 0.002;
