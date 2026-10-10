module Secrets
  # Line-level LCS diff between two values. O(n*m) memory, hence the line cap.
  module LineDiff
    MAX_LINES = 1_000

    module_function

    def call(before, after)
      a = before.split("\n")
      b = after.split("\n")
      raise VaultError.new(:validation_failed, "values exceed #{MAX_LINES} lines") if [ a.size, b.size ].max > MAX_LINES

      walk(a, b, lcs_table(a, b))
    end

    def lcs_table(a, b)
      table = Array.new(a.size + 1) { Array.new(b.size + 1, 0) }
      (a.size - 1).downto(0) do |i|
        (b.size - 1).downto(0) do |j|
          table[i][j] = a[i] == b[j] ? table[i + 1][j + 1] + 1 : [ table[i + 1][j], table[i][j + 1] ].max
        end
      end
      table
    end

    def walk(a, b, table)
      lines = []
      i = j = 0
      while i < a.size || j < b.size
        if i < a.size && j < b.size && a[i] == b[j]
          lines << { type: "context", text: a[i], aLine: i + 1, bLine: j + 1 }
          i += 1
          j += 1
        elsif j >= b.size || (i < a.size && table[i + 1][j] >= table[i][j + 1])
          lines << { type: "remove", text: a[i], aLine: i + 1 }
          i += 1
        else
          lines << { type: "add", text: b[j], bLine: j + 1 }
          j += 1
        end
      end
      lines
    end
  end
end
