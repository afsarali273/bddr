Feature: Payments
  @id:take-payment @dependsOn:place-order @lock:gateway
  Scenario: take a payment
    Given a slow step

  @id:refund @dependsOn:take-payment @lock:gateway
  Scenario: refund the payment
    Given a passing step

  @id:broken
  Scenario: a broken export
    Given a failing step

  @id:uses-broken @dependsOn:broken
  Scenario: needs the broken export
    Given a passing step

  @id:soft-uses-broken @dependsOn:broken:soft
  Scenario: tolerates the broken export
    Given a passing step
