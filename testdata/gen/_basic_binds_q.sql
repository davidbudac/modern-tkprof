select /* mtk_basic_binds */ c.id, c.name, c.amount, c.created,
       :b_num as n, :b_vc2 as v, :b_chr as ch, :b_dbl as d, :b_flt as f,
       :b_null as nul, length(:b_long) as lng
  from mtk_cust c
 where c.id between :b_lo and :b_hi
   and (:b_null is null or c.name = :b_null)
 order by c.id;
