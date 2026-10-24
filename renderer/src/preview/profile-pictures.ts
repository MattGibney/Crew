/** Fictional illustrated profile pictures, generated locally for the UI preview. */
export function sampleProfilePictures(): Record<string, string> {
  const palettes = [
    ["#d9e8ee", "#b97c56", "#302d35", "#315a70"],
    ["#f0dfd7", "#e2b99c", "#984e32", "#95616b"],
    ["#dce8dc", "#80533e", "#292b2b", "#52705b"],
    ["#e4e0ef", "#d5a57f", "#514034", "#675783"],
  ];
  return Object.fromEntries(
    palettes.map(([background, skin, hair, shirt], index) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 192;
      const context = canvas.getContext("2d")!;
      const ellipse = (
        x: number,
        y: number,
        rx: number,
        ry: number,
        color: string,
      ) => {
        context.fillStyle = color;
        context.beginPath();
        context.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
        context.fill();
      };
      context.fillStyle = background;
      context.fillRect(0, 0, 192, 192);
      ellipse(96, 190, 76, 58, shirt);
      ellipse(96, 82, 48, index === 1 || index === 3 ? 65 : 49, hair);
      context.fillStyle = skin;
      context.fillRect(83, 114, 26, 33);
      ellipse(96, 87, 36, 46, skin);
      ellipse(78, 47, 30, 17, hair);
      ellipse(109, 45, 25, 14, hair);
      ellipse(83, 85, 3, 3, "#302b2b");
      ellipse(109, 85, 3, 3, "#302b2b");
      context.strokeStyle = "#794c40";
      context.lineWidth = 2.5;
      context.beginPath();
      context.arc(96, 102, 10, 0.2, Math.PI - 0.2);
      context.stroke();
      return [`preview:profile-${index}`, canvas.toDataURL("image/png")];
    }),
  );
}
