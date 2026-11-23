id: checkout-within-balance
tags: smoke, payments

Ann has 20.00 in her wallet. She adds one apple (7.50) to her basket and pays for it.
The payment should go through: she sees a "Payment received" confirmation,
12.50 is left in her wallet, and exactly one order is recorded for her.

```checks
C1 a "Payment received" confirmation is shown
C2 the wallet holds 12.50
C3 exactly one order exists for Ann
```
