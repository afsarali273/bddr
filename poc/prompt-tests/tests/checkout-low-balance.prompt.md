id: checkout-low-balance
tags: smoke, payments

A customer whose wallet holds 5.00 tries to pay for a basket with one apple (7.50).
The payment must be refused with the message "Insufficient funds",
the wallet must still hold 5.00 afterwards, and no order may be created.

```checks
C1 the payment is refused with the message "Insufficient funds"
C2 the wallet still holds 5.00
C3 no order exists for this customer
```
