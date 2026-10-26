cask "gitgui" do
  version "@VERSION@"
  sha256 "@DMG_SHA256@"

  url "https://github.com/MDHaarith/GitGUI/releases/download/v#{version}/GitGUI_#{version}_universal.dmg"
  name "GitGUI"
  desc "Visual Git history and everyday repository workflows"
  homepage "https://github.com/MDHaarith/GitGUI"

  depends_on formula: "git"

  app "GitGUI.app"
end
