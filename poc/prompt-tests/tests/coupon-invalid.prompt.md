id: coupon-invalid
tags: payments

With one melon (20.00) in the basket, a customer types the coupon "BOGUS".
The shop must say "Coupon not valid" and the total must stay at 20.00.

```checks
C1 the message "Coupon not valid" is shown
C2 the basket total is still 20.00
```
