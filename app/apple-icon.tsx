import { ImageResponse } from 'next/og';

// Image metadata
export const size = {
  width: 180,
  height: 180,
};
export const contentType = 'image/png';

// Image generation
export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          fontSize: 120,
          background: '#1a3d2f',
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 40,
          color: '#86efac',
          fontWeight: 800,
          fontFamily: 'sans-serif',
        }}
      >
        V
      </div>
    ),
    {
      ...size,
    }
  );
}
