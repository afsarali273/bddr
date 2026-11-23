Feature: Setup
  @id:seed-users @group:setup
  Scenario: seed users
    Given a slow step
    And I export "users-ready"

  @id:seed-catalogue @group:setup
  Scenario: seed catalogue
    Given a passing step
