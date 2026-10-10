require "rails_helper"

RSpec.describe Workspace do
  it "should accept a lowercase slug" do
    expect(build(:workspace, slug: "prod-eu-1")).to be_valid
  end

  it "should reject slugs with uppercase, spaces or a leading dash" do
    %w[Prod prod\ eu -prod].each do |slug|
      expect(build(:workspace, slug: slug)).not_to be_valid
    end
  end

  it "should enforce unique slugs in the database" do
    create(:workspace, slug: "dup")

    expect { build(:workspace, slug: "dup").save(validate: false) }.to raise_error(ActiveRecord::RecordNotUnique)
  end

  it "should reject an unknown status" do
    expect(build(:workspace, status: "deleted")).not_to be_valid
  end
end
