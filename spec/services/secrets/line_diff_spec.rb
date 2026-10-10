require "rails_helper"

RSpec.describe Secrets::LineDiff do
  def types(before, after) = described_class.call(before, after).map { |line| line[:type] }

  it "should mark unchanged lines as context with both line numbers" do
    expect(described_class.call("a\nb", "a\nb")).to eq([
      { type: "context", text: "a", aLine: 1, bLine: 1 },
      { type: "context", text: "b", aLine: 2, bLine: 2 }
    ])
  end

  it "should report an inserted line as an addition" do
    expect(types("a\nc", "a\nb\nc")).to eq(%w[context add context])
  end

  it "should report a changed line as a removal followed by an addition" do
    expect(types("key=old", "key=new")).to eq(%w[remove add])
  end

  it "should handle an empty side" do
    expect(types("", "a\nb")).to eq(%w[add add])
  end

  it "should refuse values over the line cap" do
    big = Array.new(described_class::MAX_LINES + 1, "x").join("\n")

    expect { described_class.call(big, "x") }.to raise_error(VaultError) { |error| expect(error.code).to eq(:validation_failed) }
  end
end
