const Logo = ({ ...props }) => (
  <svg
    width="32"
    height="32"
    viewBox="0 0 32 32"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    {...props}
  >
    <rect width="32" height="32" rx="10" fill="currentColor" className="text-primary"/>
    <text
      x="50%"
      y="58%"
      dominantBaseline="middle"
      textAnchor="middle"
      className="fill-background"
      style={{ fontFamily: 'sans-serif', fontWeight: 800, fontSize: '20px' }}
    >
      V
    </text>
  </svg>
);

export default Logo;
