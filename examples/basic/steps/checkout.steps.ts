import { strict as assert } from 'node:assert';
import { CONTEXT, Given, Steps, Then, When, type StepContext } from '@bddr/runtime';

/** A plain helper class: injected, one instance per scenario, disposed at the end. */
export class Wallet {
  static inject = [CONTEXT] as const;
  cents = 0;
  receipts: number[] = [];
  constructor(private ctx: StepContext) {}
  pay(cents: number) {
    if (cents > this.cents) throw new Error('insufficient funds');
    this.cents -= cents;
    this.receipts.push(cents);
    this.ctx.log(`paid ${cents} cents`);
  }
  dispose() {
    this.ctx.log(`wallet closed with ${this.cents} cents`);
  }
}

@Steps()
export class CheckoutSteps {
  static inject = [Wallet] as const;
  constructor(private wallet: Wallet) {}

  @Given('a customer with {money} in their wallet')
  fund(cents: number) {
    this.wallet.cents = cents;
  }

  @When('they pay {money}')
  pay(cents: number) {
    this.wallet.pay(cents);
  }

  @Then('their wallet has {money} left')
  left(cents: number) {
    assert.equal(this.wallet.cents, cents);
  }
}

@Steps()
export class ReceiptSteps {
  static inject = [Wallet] as const;
  constructor(private wallet: Wallet) {}

  @Then('a receipt was issued')
  receipt() {
    assert.equal(this.wallet.receipts.length, 1);
  }
}
