@requires:01-setup.feature
Feature: Orders
  @id:place-order
  Scenario: place an order
    Given a passing step
    And I read the export of "seed-users" and expect "users-ready"

  @id:cancel-order @dependsOn:place-order
  Scenario: cancel the order
    Given a passing step
